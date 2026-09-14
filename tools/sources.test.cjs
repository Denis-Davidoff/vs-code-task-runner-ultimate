const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { minimatch } = require('minimatch');

// The parsers are module-private, so the file is transpiled and run with a small
// workspace mock that answers the two things a parse can ask the world: what the
// settings say, and whether a file is there.
const source = fs.readFileSync(path.join(__dirname, '../src/sources.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** A URI as much as the scan ever asks one to be. */
function uri(at) {
  return { path: at, fsPath: at, toString: () => `file://${at}`, with: (c) => uri(c.path ?? at) };
}

/**
 * @param present  files `exists` should find, by path
 * @param found    what `findFiles` hands back, by path
 * @param root     the workspace folder every file is inside, or none at all
 */
function harness({ settings = {}, present = [], found = [], root } = {}) {
  const onDisk = new Set(present);
  const calls = [];
  const contents = found && !Array.isArray(found) ? found : Object.fromEntries((found ?? []).map((at) => [at, '']));
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (key) => settings[key] }),
      getWorkspaceFolder: () => (root ? { uri: uri(root) } : undefined),
      // The glob is honoured rather than ignored, and the call is recorded. A
      // stub that swallowed its arguments let the pattern list, the exclude and
      // the result cap all be dropped from `collectShellScripts` with every
      // test still green — the setting these tests are named after was the one
      // thing they could not see.
      findFiles: async (include, exclude, max) => {
        calls.push({ include, exclude, max });
        const inside = (at) => (root ? path.posix.relative(root, at) : at);
        return Object.keys(contents)
          .filter((at) => minimatch(inside(at), include))
          .filter((at) => !exclude || !minimatch(inside(at), exclude))
          .slice(0, max ?? Infinity)
          .map(uri);
      },
      fs: {
        stat: async (target) => {
          if (!onDisk.has(target.path)) {
            throw new Error(`no such file: ${target.path}`);
          }
          return {};
        },
        readFile: async (target) => Buffer.from(contents[target.path] ?? '', 'utf8'),
      },
    },
    Uri: {
      joinPath: (target, ...parts) => ({ path: [target.path, ...parts].join('/') }),
    },
  };
  const context = vm.createContext({
    exports: {},
    Buffer,
    require: (name) => (name === 'vscode' ? vscode : name === 'path' ? path : {}),
  });
  vm.runInContext(
    compiled +
      `
    exports.parsers = { parseCompose, yamlBlockKeys, shellDescription, manifestKind, collectShellScripts };
  `,
    context,
  );
  return { ...context.exports.parsers, calls };
}

const cwd = { path: '/repo' };

/**
 * The same data, built out of this realm's own Array and Object.
 *
 * Everything a parser returns is constructed inside the vm context, and
 * `deepStrictEqual` compares prototypes — a nested array from in there is never
 * reference-equal to one written out here, however identical it reads.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const COMPOSE = `name: acme
services:
  web:
    build: .
    ports:
      - "3000:3000"
  db:
    image: postgres:16
volumes:
  data:
`;

// --- yamlBlockKeys -----------------------------------------------------------

test('yamlBlockKeys reads the keys of one block and stops at the next', () => {
  const { yamlBlockKeys } = harness();
  const entries = yamlBlockKeys(COMPOSE.split('\n'), 'services');
  assert.deepEqual(plain(entries.map((entry) => entry.name)), ['web', 'db']);
  assert.deepEqual(plain(entries[1].body), ['image: postgres:16']);
  // The line is what `locate.ts` opens, so it has to be the key's own.
  assert.equal(COMPOSE.split('\n')[entries[0].line].trim(), 'web:');
});

test('yamlBlockKeys keeps namespaced keys whole and skips comments', () => {
  const { yamlBlockKeys } = harness();
  const text = ['tasks:', '  # a comment', '  docker:build:', '    desc: Build it', 'other:', '  x: 1'];
  const entries = yamlBlockKeys(text, 'tasks');
  assert.deepEqual(plain(entries.map((entry) => entry.name)), ['docker:build']);
  assert.deepEqual(plain(entries[0].body), ['desc: Build it']);
});

test('yamlBlockKeys finds nothing when the block is absent', () => {
  const { yamlBlockKeys } = harness();
  assert.deepEqual(plain(yamlBlockKeys(['version: "3"'], 'services')), []);
});

// --- shellDescription --------------------------------------------------------

test('shellDescription skips the shebang and the tool pragmas', () => {
  const { shellDescription } = harness();
  const text = [
    '#!/usr/bin/env bash',
    '# shellcheck disable=SC2086',
    '# vim: ft=sh',
    '#',
    '# Deploy the API to staging.',
    'set -euo pipefail',
  ].join('\n');
  assert.equal(shellDescription(text), 'Deploy the API to staging.');
});

test('shellDescription reaches a comment that sits below the preamble', () => {
  const { shellDescription } = harness();
  const text = ['#!/bin/bash', 'set -e', 'cd "$(dirname "$0")/.."', '# Build everything', 'make all'].join('\n');
  assert.equal(shellDescription(text), 'Build everything');
});

test('shellDescription reads the two openers a batch file has', () => {
  const { shellDescription } = harness();
  assert.equal(shellDescription('@echo off\nREM Ship the API.\n'), 'Ship the API.');
  assert.equal(shellDescription('@echo off\n:: Ship the API.\n'), 'Ship the API.');
  // `remove-old-logs` opens with the same three letters and is not a comment.
  assert.equal(shellDescription('remove-old-logs.exe\n:: Ship it.\n'), 'Ship it.');
});

test('shellDescription has nothing to say about a file with no comments', () => {
  const { shellDescription } = harness();
  assert.equal(shellDescription('#!/bin/sh\nmake all\n'), undefined);
});

// --- parseCompose ------------------------------------------------------------

test('parseCompose lists the default commands and fans `up` out over the services', async () => {
  const { parseCompose } = harness();
  const parsed = await parseCompose(COMPOSE, 'docker-compose.yml', cwd);
  assert.equal(parsed.packageName, 'acme');
  assert.deepEqual(plain(parsed.tasks.map((task) => task.name)), [
    'up',
    'up: web',
    'up: db',
    'down',
    'build',
    'logs',
    'ps',
  ]);
  assert.deepEqual(plain(parsed.tasks[0].argv), ['docker', 'compose', '-f', 'docker-compose.yml', 'up']);
  assert.deepEqual(plain(parsed.tasks[1].argv), ['docker', 'compose', '-f', 'docker-compose.yml', 'up', 'web']);
  // `logs` without `-f` would exit at once and leave a row that never spins.
  assert.deepEqual(plain(parsed.tasks[5].argv), ['docker', 'compose', '-f', 'docker-compose.yml', 'logs', '-f']);
  // Nothing is ever run detached: a `-d` row would idle with the stack still up.
  assert.ok(!parsed.tasks.some((task) => task.argv.includes('-d')));
});

test('parseCompose leaves `up` alone when the file declares one service', async () => {
  const { parseCompose } = harness();
  const parsed = await parseCompose('services:\n  web:\n    image: nginx\n', 'compose.yaml', cwd);
  assert.deepEqual(plain(parsed.tasks.map((task) => task.name)), ['up', 'down', 'build', 'logs', 'ps']);
  assert.equal(parsed.packageName, undefined);
});

test('parseCompose appends the override file when one sits beside the manifest', async () => {
  const { parseCompose } = harness({ present: ['/repo/docker-compose.override.yml'] });
  const parsed = await parseCompose(COMPOSE, 'docker-compose.yml', cwd);
  assert.deepEqual(plain(parsed.tasks[0].argv), [
    'docker',
    'compose',
    '-f',
    'docker-compose.yml',
    '-f',
    'docker-compose.override.yml',
    'up',
  ]);
});

test('parseCompose honours the command list and the v1 spelling', async () => {
  const { parseCompose } = harness({
    settings: { dockerCompose: 'docker-compose', dockerComposeCommands: ['restart', 'top'] },
  });
  const parsed = await parseCompose(COMPOSE, 'compose.yml', cwd);
  assert.deepEqual(
    plain(parsed.tasks.map((task) => task.argv)),
    [
      ['docker-compose', '-f', 'compose.yml', 'restart'],
      // An unknown name runs as itself.
      ['docker-compose', '-f', 'compose.yml', 'top'],
    ],
  );
});

test('parseCompose returns nothing at all for an empty command list', async () => {
  const { parseCompose } = harness({ settings: { dockerComposeCommands: [] } });
  // Not `{ tasks: [] }`: that lands in `emptyManifests`, and `pruneStaleRefs`
  // would delete every star and colour filed against the file.
  assert.equal(await parseCompose(COMPOSE, 'docker-compose.yml', cwd), undefined);
});

test('the override is matched by compose order, not by the base file extension', async () => {
  // compose searches its own four spellings whatever the base file is called, so
  // `compose.yaml` beside `compose.override.yml` is a pair it merges.
  const { parseCompose } = harness({ present: ['/repo/compose.override.yml'] });
  const parsed = await parseCompose(COMPOSE, 'compose.yaml', cwd);
  assert.deepEqual(plain(parsed.tasks[0].argv), [
    'docker',
    'compose',
    '-f',
    'compose.yaml',
    '-f',
    'compose.override.yml',
    'up',
  ]);
});

test('a profile-named compose file gets no override merged into it', async () => {
  // The merge is something compose does to the file it chose for itself, and
  // `docker-compose.dev.yml` is never that file.
  const { parseCompose } = harness({ present: ['/repo/docker-compose.override.yml'] });
  const parsed = await parseCompose(COMPOSE, 'docker-compose.dev.yml', cwd);
  assert.deepEqual(plain(parsed.tasks[0].argv), [
    'docker',
    'compose',
    '-f',
    'docker-compose.dev.yml',
    'up',
  ]);
});

test('a profile-named file is believed only once it looks like compose', async () => {
  const { parseCompose } = harness();
  // No `services:` and no `include:` — a YAML file that merely matched a name.
  assert.equal(await parseCompose('jobs:\n  build:\n    runs-on: ubuntu\n', 'compose.ci.yml', cwd), undefined);
  // The four default names are trusted on the name alone.
  const parsed = await parseCompose('version: "3"\n', 'docker-compose.yml', cwd);
  assert.deepEqual(plain(parsed.tasks.map((task) => task.name)), ['up', 'down', 'build', 'logs', 'ps']);
});

test('manifestKind recognises the profile-named compose files and only those', () => {
  const { manifestKind } = harness();
  const kind = (name) => manifestKind({ path: `/repo/${name}` });
  for (const name of ['docker-compose.yml', 'compose.yaml', 'docker-compose.dev.yml', 'compose.prod.yaml']) {
    assert.equal(kind(name), 'docker-compose', name);
  }
  // An override is read as part of the file beside it, never as a group.
  assert.equal(kind('docker-compose.override.yml'), undefined);
  assert.equal(kind('compose.override.yaml'), undefined);
  // `compose` has to be followed by a dot, so this is not one.
  assert.equal(kind('composer.yml'), undefined);
  assert.equal(kind('deploy.staging.yml'), undefined);
});

// --- the shell scan ----------------------------------------------------------

test('the shell scan groups by directory and runs from the workspace root', async () => {
  const { collectShellScripts } = harness({
    root: '/repo',
    found: {
      '/repo/scripts/deploy.sh': '#!/usr/bin/env bash\n# Ship it.\n',
      '/repo/scripts/ci/lint.sh': '',
      '/repo/release.sh': '',
    },
  });
  const rows = plain(await collectShellScripts('**/none'));

  assert.deepEqual(
    rows.map((row) => [row.name, row.location, row.directory]),
    [
      // Shallower folders first, and a group's scripts in one run: the directory
      // is the group, so `scripts/ci` is a heading of its own rather than a row
      // under `scripts`.
      ['release.sh', 'repo', ''],
      ['deploy.sh', 'scripts', ''],
      ['lint.sh', 'scripts/ci', 'scripts'],
    ],
  );
  // The path is relative to the workspace folder root, which is also the cwd —
  // that is where a `scripts/*.sh` is written to be run from.
  assert.deepEqual(
    rows.map((row) => row.argv),
    [
      ['bash', './release.sh'],
      ['bash', './scripts/deploy.sh'],
      ['bash', './scripts/ci/lint.sh'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.cwd.path),
    ['/repo', '/repo', '/repo'],
  );
  // The manifest is the directory, which is what the group's ref is read off,
  // and `file` is the script the row actually opens.
  assert.equal(rows[1].manifest.path, '/repo/scripts');
  assert.equal(rows[1].file.path, '/repo/scripts/deploy.sh');
  // The first comment written for a person becomes the dimmed text; a file with
  // nothing to say falls back to the command.
  assert.equal(rows[1].command, 'Ship it.');
  assert.equal(rows[2].command, 'bash ./scripts/ci/lint.sh');
});

test('the shell scan honours an empty runner and a narrowed pattern list', async () => {
  const h = harness({
    root: '/repo',
    settings: { shellRunner: '  ', shellScripts: ['bin/*.sh'] },
    found: { '/repo/bin/build.sh': '', '/repo/scripts/deploy.sh': '' },
  });
  const rows = plain(await h.collectShellScripts('**/exclude-me'));
  // The narrowed pattern is the whole point: `scripts/deploy.sh` is on disk and
  // must not come back.
  assert.deepEqual(rows.map((row) => row.name), ['build.sh']);
  assert.deepEqual(plain(rows[0].argv), ['./bin/build.sh']);
  // A single pattern goes through as itself; the exclude and the cap reach
  // `findFiles` rather than being dropped on the way.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].include, 'bin/*.sh');
  assert.equal(h.calls[0].exclude, '**/exclude-me');
  assert.equal(h.calls[0].max, 200);
});

test('several patterns are joined into one brace glob', async () => {
  const h = harness({
    root: '/repo',
    settings: { shellScripts: ['bin/*.sh', 'tools/*.sh'] },
    found: { '/repo/bin/a.sh': '', '/repo/tools/b.sh': '', '/repo/other/c.sh': '' },
  });
  const rows = plain(await h.collectShellScripts('**/none'));
  assert.equal(h.calls[0].include, '{bin/*.sh,tools/*.sh}');
  assert.deepEqual(rows.map((row) => row.name).sort(), ['a.sh', 'b.sh']);
});

test('the default patterns reach a package of a monorepo, and the root', async () => {
  // The leading globstar is what carries the first two past the workspace root;
  // without it `apps/web/scripts/deploy.sh` is never found at all.
  const h = harness({
    root: '/repo',
    found: {
      '/repo/apps/web/scripts/deploy.sh': '',
      '/repo/bin/ci/build.sh': '',
      '/repo/release.sh': '',
      '/repo/apps/web/loose.sh': '',
    },
  });
  const rows = plain(await h.collectShellScripts('**/none'));
  assert.deepEqual(rows.map((row) => row.name).sort(), ['build.sh', 'deploy.sh', 'release.sh']);
  // A loose `.sh` below the root is not one of them: the third pattern carries
  // no prefix on purpose.
  //
  // Every pattern reaches `findFiles` with its `{sh,bash,…}` group already
  // expanded: VS Code's glob parser closes a group at the first `}` it meets, so
  // a braced pattern joined into the braced list would match nothing at all.
  const where = ['**/scripts/**/', '**/bin/**/', ''];
  const what = ['sh', 'bash', 'zsh', 'ksh', 'ps1', 'bat', 'cmd'];
  assert.equal(
    h.calls[0].include,
    `{${where.flatMap((at) => what.map((extension) => `${at}*.${extension}`)).join(',')}}`,
  );
});

test('a pattern of your own may carry a brace group too', async () => {
  const h = harness({
    root: '/repo',
    settings: { shellScripts: ['tools/{ci,dev}/*.sh'] },
    found: { '/repo/tools/ci/lint.sh': '', '/repo/tools/dev/watch.sh': '', '/repo/tools/x/other.sh': '' },
  });
  const rows = plain(await h.collectShellScripts('**/none'));
  assert.deepEqual(rows.map((row) => row.name).sort(), ['lint.sh', 'watch.sh']);
  assert.equal(h.calls[0].include, '{tools/ci/*.sh,tools/dev/*.sh}');
});

test('each extension is run through the words that can start it', async () => {
  const h = harness({
    root: '/repo',
    found: {
      '/repo/bin/deploy.sh': '',
      '/repo/bin/build.zsh': '',
      '/repo/bin/setup.ps1': '',
      '/repo/bin/run.bat': '',
    },
  });
  const rows = plain(await h.collectShellScripts('**/none'));
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.name, row.argv])),
    {
      // The Bourne family, `shellRunner` and all.
      'deploy.sh': ['bash', './bin/deploy.sh'],
      'build.zsh': ['bash', './bin/build.zsh'],
      // Windows PowerShell, which is the one a stock Windows has.
      'setup.ps1': ['powershell', '-NoProfile', '-File', './bin/setup.ps1'],
      // A batch file is a program to Windows already.
      'run.bat': ['./bin/run.bat'],
    },
  );
});

test('a runner of your own stands in for the built-in one, by extension', async () => {
  const h = harness({
    root: '/repo',
    // Spelled with the dot anyone would write, and in the case they wrote it.
    settings: { shellRunners: { '.PS1': 'pwsh -NoProfile -File', bat: 'cmd /c' } },
    found: { '/repo/bin/setup.ps1': '', '/repo/bin/run.bat': '', '/repo/bin/deploy.sh': '' },
  });
  const rows = plain(await h.collectShellScripts('**/none'));
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.name, row.argv])),
    {
      'setup.ps1': ['pwsh', '-NoProfile', '-File', './bin/setup.ps1'],
      'run.bat': ['cmd', '/c', './bin/run.bat'],
      // Untouched by the map, so still `shellRunner`'s business.
      'deploy.sh': ['bash', './bin/deploy.sh'],
    },
  );
});

test('the shell scan reads nothing at all when the pattern list is emptied', async () => {
  const { collectShellScripts } = harness({
    root: '/repo',
    settings: { shellScripts: [] },
    found: { '/repo/bin/build.sh': '' },
  });
  assert.deepEqual(plain(await collectShellScripts('**/none')), []);
});
