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
function harness({ settings = {}, present = [], found = [], root, directory = {} } = {}) {
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
          if (!onDisk.has(target.path) && !(target.path in contents)) {
            throw new Error(`no such file: ${target.path}`);
          }
          return { size: Buffer.byteLength(contents[target.path] ?? '', 'utf8') };
        },
        readFile: async (target) => Buffer.from(contents[target.path] ?? '', 'utf8'),
        readDirectory: async (target) => directory[target.path] ?? [],
      },
    },
    Uri: {
      joinPath: (target, ...parts) => ({ path: [target.path, ...parts].join('/') }),
    },
    FileType: { File: 1, Directory: 2 },
  };
  const context = vm.createContext({
    exports: {},
    Buffer,
    process,
    require: (name) => (name === 'vscode' ? vscode : name === 'path' ? path : {}),
  });
  vm.runInContext(
    compiled +
      `
    exports.parsers = { parseCompose, parseDockerfile, yamlBlockKeys, shellDescription, manifestKind, collectShellScripts, parseMakefile, parseJustfile, parseDenoJson, parsePackageJson, parseGoMod, readText, RUNNERS, SOURCE_GLOB: exports.SOURCE_GLOB, GO_GLOB: exports.GO_GLOB };
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

test('shellDescription reads the batch openers only in a batch file', () => {
  const { shellDescription } = harness();
  const text = '#!/bin/bash\nREM=$(git rev-parse HEAD)\n# Deploy to staging.\n';
  assert.equal(shellDescription(text, 'sh'), 'Deploy to staging.');
  assert.equal(shellDescription('@echo off\nREM Ship it.\n', 'bat'), 'Ship it.');
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

test('parseCompose offers `up` for a file and for its only service', async () => {
  const { parseCompose } = harness();
  const parsed = await parseCompose('services:\n  web:\n    image: nginx\n', 'compose.yaml', cwd);
  assert.deepEqual(plain(parsed.tasks.map((task) => task.name)), ['up', 'up: web', 'down', 'build', 'logs', 'ps']);
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
      ['docker-compose', '-f', 'compose.yml', 'up'],
      ['docker-compose', '-f', 'compose.yml', 'up', 'web'],
      ['docker-compose', '-f', 'compose.yml', 'up', 'db'],
      ['docker-compose', '-f', 'compose.yml', 'down'],
      ['docker-compose', '-f', 'compose.yml', 'restart'],
      // An unknown name runs as itself.
      ['docker-compose', '-f', 'compose.yml', 'top'],
    ],
  );
});

test('parseCompose keeps the fixed up and down actions for an empty extra-command list', async () => {
  const { parseCompose } = harness({ settings: { dockerComposeCommands: [] } });
  const parsed = await parseCompose(COMPOSE, 'docker-compose.yml', cwd);
  assert.deepEqual(plain(parsed.tasks.map((task) => task.name)), ['up', 'up: web', 'up: db', 'down']);
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
  // An override is read as part of the file beside it, never as a group —
  // wherever in the name the token sits, and however many segments follow it.
  // Spelling out the tail instead let `compose.dev.override.local.ci.yml`
  // through, and a fragment with no image became a heading offering to run it.
  assert.equal(kind('docker-compose.override.yml'), undefined);
  assert.equal(kind('compose.override.yaml'), undefined);
  assert.equal(kind('compose.dev.override.yml'), undefined);
  assert.equal(kind('compose.override.local.yml'), undefined);
  assert.equal(kind('compose.dev.override.local.ci.yml'), undefined);
  assert.equal(kind('docker-compose.a.override.b.c.yaml'), undefined);
  // `compose` has to be followed by a dot, so this is not one.
  assert.equal(kind('composer.yml'), undefined);
  assert.equal(kind('deploy.staging.yml'), undefined);
});

// --- Dockerfile --------------------------------------------------------------

const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:20 AS deps
RUN npm ci

FROM deps AS builder
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
`;

test('a Dockerfile offers build, the configured extras, and one build per named stage', async () => {
  const { parseDockerfile } = harness();
  const parsed = plain(await parseDockerfile(DOCKERFILE, 'Dockerfile', { path: '/repo/apps/api' }));

  assert.deepEqual(
    parsed.tasks.map((task) => task.name),
    // `build` first whatever the setting says, then its stages, then the rest.
    // The unnamed last stage is not a row: `--target` needs a name.
    ['build', 'build: deps', 'build: builder', 'run'],
  );
  assert.deepEqual(parsed.tasks.map((task) => task.command), [
    'docker build -f Dockerfile -t api .',
    // The stage is a path segment on the repository, not part of the tag — see
    // `imageTag`, and the collision test below for why.
    'docker build -f Dockerfile --target deps -t api/deps .',
    'docker build -f Dockerfile --target builder -t api/builder .',
    'docker run --rm -it api',
  ]);
  // A task name reaches a shell, so the words are carried as a vector.
  assert.deepEqual(parsed.tasks[1].argv, [
    'docker', 'build', '-f', 'Dockerfile', '--target', 'deps', '-t', 'api/deps', '.',
  ]);
  // Nothing in a Dockerfile names the project, so no heading is claimed from it.
  assert.equal(parsed.packageName, undefined);
});

test('a profile in the file name qualifies the tag, stage and all', async () => {
  const { parseDockerfile } = harness({ settings: { dockerfileCommands: ['run', 'push'] } });
  const at = { path: '/repo/apps/api' };
  for (const file of ['Dockerfile.dev', 'dev.Dockerfile']) {
    const parsed = plain(await parseDockerfile(DOCKERFILE, file, at));
    assert.deepEqual(
      parsed.tasks.map((task) => task.command),
      [
        `docker build -f ${file} -t api:dev .`,
        `docker build -f ${file} --target deps -t api/deps:dev .`,
        `docker build -f ${file} --target builder -t api/builder:dev .`,
        'docker run --rm -it api:dev',
        'docker push api:dev',
      ],
      file,
    );
  }
});

/** What a row tags its image: the word after `-t`, wherever the flags put it. */
const tagged = (task) => task.argv[task.argv.indexOf('-t') + 1];

test('the derived tag is a name Docker will take', async () => {
  const { parseDockerfile } = harness({ settings: { dockerfileCommands: [] } });
  const tag = async (folder, file = 'Dockerfile') =>
    tagged(plain(await parseDockerfile('FROM scratch\n', file, { path: `/repo/${folder}` })).tasks[0]);
  // The repository half is lower case only, which is the half Docker insists on.
  assert.equal(await tag('MyApp'), 'myapp');
  // Everything outside Docker's own alphabet becomes a dash, and a separator
  // cannot lead: `docker build -t -web .` is a parse error, not an image.
  assert.equal(await tag('@acme-web'), 'acme-web');
  assert.equal(await tag('_edge_'), 'edge');
  // A folder with nothing left in it still has to build something.
  assert.equal(await tag('@@@'), 'image');
  // The tag half keeps its case, since Docker allows it there.
  assert.equal(await tag('api', 'Dockerfile.CI'), 'api:CI');
});

test('no two rows of a folder can build the same image', async () => {
  // The reference has two halves and the two things that tell these rows apart
  // take one each, so the mapping is reversible. Joined into one they were not:
  // a `Dockerfile.dev` with no target and a `Dockerfile` targeting a stage
  // called `dev` both read `api:dev`, and the second build silently retagged the
  // first — after which `run` started an image built from the other file.
  const { parseDockerfile } = harness({ settings: { dockerfileCommands: [] } });
  const at = { path: '/repo/apps/api' };
  const built = async (file, body) =>
    plain(await parseDockerfile(body, file, at)).tasks.map(tagged);

  const plainFile = await built('Dockerfile', 'FROM scratch AS dev\nFROM scratch AS prod\n');
  const profiled = await built('Dockerfile.dev', 'FROM scratch AS prod\n');
  // The pair the old scheme collapsed: stage `dev` against profile `dev`.
  assert.deepEqual(plainFile, ['api', 'api/dev', 'api/prod']);
  assert.deepEqual(profiled, ['api:dev', 'api/prod:dev']);

  // And the other pair it collapsed: profile `dev` + stage `prod` against a
  // profile that happens to be spelled `dev-prod`.
  const joined = await built('Dockerfile.dev-prod', 'FROM scratch\n');
  assert.deepEqual(joined, ['api:dev-prod']);

  const all = [...plainFile, ...profiled, ...joined];
  assert.equal(new Set(all).size, all.length, 'every row must build a reference of its own');
});

test('a known verb keeps its file, its tag and its context when flags follow it', async () => {
  const { parseDockerfile } = harness({
    settings: { dockerfileCommands: ['build --no-cache', 'run --name api'] },
  });
  const parsed = plain(await parseDockerfile('FROM scratch AS deps\n', 'Dockerfile', cwd));
  assert.deepEqual(parsed.tasks.map((task) => task.command), [
    'docker build -f Dockerfile -t repo .',
    'docker build -f Dockerfile --target deps -t repo/deps .',
    // The verb alone decides what this is. Matched on the whole of what was
    // written, this fell through to the verbatim branch as
    // `docker build --no-cache` — a build with no context, which fails before it
    // starts.
    'docker build -f Dockerfile --no-cache -t repo .',
    // The flags go before the image, which `run` takes last.
    'docker run --rm -it --name api repo',
  ]);
  // A verb carrying flags is the one row that was asked for: only the bare
  // `build` fans out, which is the rule `parseCompose` already follows for `up`.
  assert.equal(parsed.tasks.filter((task) => task.name.startsWith('build --no-cache')).length, 1);
});

test('a verb of the user\'s own runs as written, with no file and no image bolted on', async () => {
  const { parseDockerfile } = harness({
    settings: { dockerfileCommands: ['builder prune -f', 'run -d', 'build'] },
  });
  const parsed = plain(await parseDockerfile('FROM scratch\n', 'Dockerfile', cwd));
  assert.deepEqual(parsed.tasks.map((task) => task.command), [
    // `build` is the fixed row and listing it again does not repeat it.
    'docker build -f Dockerfile -t repo .',
    'docker builder prune -f',
    // Detaching is dropped, and the row is named by what it actually runs — so
    // `run -d` lands on `run`, which already knows what to do with the image.
    'docker run --rm -it repo',
  ]);
});

test('a file matched by name that builds nothing declares no tasks', async () => {
  const { parseDockerfile } = harness();
  const readme = '# Dockerfile.md\n\nHow to write one: start with `FROM`.\n';
  // Read and understood, and empty — not undefined, which is what a file the
  // scan could not make sense of comes back as.
  assert.deepEqual(plain(await parseDockerfile(readme, 'Dockerfile.md', cwd)), { tasks: [] });
});

test('manifestKind recognises the Dockerfile conventions and only those', () => {
  const { manifestKind } = harness();
  const kind = (name) => manifestKind({ path: `/repo/${name}` });
  for (const name of ['Dockerfile', 'dockerfile', 'Dockerfile.dev', 'api.Dockerfile', 'web.dockerfile']) {
    assert.equal(kind(name), 'dockerfile', name);
  }
  // The word has to be the whole of one side of the dot.
  assert.equal(kind('Dockerfileish'), undefined);
  assert.equal(kind('.dockerignore'), undefined);
  assert.equal(kind('docker-compose.yml'), 'docker-compose');
});

// --- the three lists that have to agree ---------------------------------------

test('the scan, the manifest and the activation globs name the same extensions', () => {
  // These three live in three files and cannot import each other: the generator
  // runs before anything is compiled, and package.json is data. They have gone
  // out of step once already — the scan grew from `.sh` to seven extensions and
  // `activationEvents` did not, so a repository whose tasks were all `.ps1`
  // woke the extension only when somebody opened the view by hand.
  const read = (at) => fs.readFileSync(path.join(__dirname, at), 'utf8');
  const extensions = read('../src/sources.ts')
    .match(/export const SHELL_EXTENSIONS: ReadonlyArray<string> = \[([^\]]*)\]/)[1]
    .match(/'([a-z0-9]+)'/g)
    .map((quoted) => quoted.slice(1, -1));
  assert.ok(extensions.length > 1, 'the extension list must be readable');

  const braced = `*.{${extensions.join(',')}}`;
  // The generator's activation globs.
  assert.ok(
    read('../tools/generate-contributions.js').includes(`const SHELL_FILES = '${braced}';`),
    'tools/generate-contributions.js must name the same extensions as the scan',
  );
  // The manifest's own default for the setting, which is what the scan falls
  // back to (`DEFAULT_SHELL_SCRIPTS`).
  const manifest = JSON.parse(read('../package.json'));
  assert.deepEqual(manifest.contributes.configuration.properties['taskRunnerUltimate.shellScripts'].default, [
    `**/scripts/**/${braced}`,
    `**/bin/**/${braced}`,
    braced,
  ]);
  // And every activation glob the manifest ships for those folders.
  const activation = manifest.activationEvents.filter((event) => event.includes('{'));
  assert.deepEqual(activation, [
    `workspaceContains:**/scripts/**/${braced}`,
    `workspaceContains:**/bin/**/${braced}`,
    `workspaceContains:${braced}`,
  ]);
});

test('the Dockerfile globs are the same three lists too', () => {
  // Same pairing as the shell extensions above, and the same failure waiting:
  // the scan finds a `Dockerfile.dev` the activation events never wake for, so
  // a repository whose only manifest is one shows nothing until the view is
  // opened by hand.
  const read = (at) => fs.readFileSync(path.join(__dirname, at), 'utf8');
  const globs = read('../src/sources.ts')
    .match(/const DOCKERFILE_GLOBS: ReadonlyArray<string> = \[([^\]]*)\]/)[1]
    .match(/'([^']+)'/g)
    .map((quoted) => quoted.slice(1, -1));
  assert.deepEqual(globs, ['Dockerfile.*', 'dockerfile.*', '*.Dockerfile', '*.dockerfile']);

  assert.ok(
    read('../tools/generate-contributions.js').includes(
      `const DOCKERFILE_GLOBS = [${globs.map((glob) => `'${glob}'`).join(', ')}];`,
    ),
    'tools/generate-contributions.js must name the same Dockerfile globs as the scan',
  );

  const manifest = JSON.parse(read('../package.json'));
  for (const name of ['Dockerfile', 'dockerfile', ...globs]) {
    assert.ok(
      manifest.activationEvents.includes(`workspaceContains:**/${name}`),
      `package.json must wake on ${name}`,
    );
  }
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

test('an unreasonable pattern is dropped, and takes no other pattern with it', async () => {
  // Groups multiply: `{a,b}` twenty-five times over is thirty-three million
  // patterns, and `shellScripts` is a setting a cloned repository can carry.
  const greedy = '{a,b}'.repeat(25) + '*.sh';
  const h = harness({
    root: '/repo',
    settings: { shellScripts: ['bin/*.sh', greedy] },
    found: { '/repo/bin/build.sh': '' },
  });
  const started = Date.now();
  const rows = plain(await h.collectShellScripts('**/none'));
  assert.ok(Date.now() - started < 1000, 'the expansion must not be exponential');
  // The sane pattern is untouched. Handing the greedy one back with its braces
  // intact would have nested one `{…}` group inside the joined one, and a nested
  // group is a glob that matches nothing — one bad pattern would have taken
  // `bin/` down with it.
  assert.deepEqual(rows.map((row) => row.name), ['build.sh']);
  assert.equal(h.calls[0].include, 'bin/*.sh');

  // On its own it leaves nothing to look for, and nothing is asked of the search.
  const alone = harness({ root: '/repo', settings: { shellScripts: [greedy] }, found: { '/repo/bin/build.sh': '' } });
  assert.deepEqual(plain(await alone.collectShellScripts('**/none')), []);
  assert.equal(alone.calls.length, 0);
});

test('a pattern that fits the budget is expanded however many groups it has', async () => {
  // Twelve groups, one choice each: it fits, so it expands — the pass that
  // confirms a finished expansion must not be the pass that gives up on it.
  const h = harness({
    root: '/repo',
    settings: { shellScripts: ['{b}{i}{n}/*.sh'] },
    found: { '/repo/bin/build.sh': '' },
  });
  assert.deepEqual(plain(await h.collectShellScripts('**/none')).map((row) => row.name), ['build.sh']);
  assert.equal(h.calls[0].include, 'bin/*.sh');
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

// --- manifests the review found misread --------------------------------------

const names = (parsed) => plain((parsed?.tasks ?? []).map((task) => task.name));

test('a Makefile assignment with `::=` or `:::=` is not a target', () => {
  const { parseMakefile } = harness();
  const text = 'FOO ::= $(shell pwd)\nBAR :::= x\nBAZ := y\nbuild: deps\n\tgo build\n';
  assert.deepEqual(names(parseMakefile(text, 'Makefile')), ['build']);
});

test('a Makefile define…endef body is text, not rules', () => {
  const { parseMakefile } = harness();
  const text = 'define HELP\nUsage: make <target>\nTargets: build test\nendef\n\nbuild:\n\techo\n';
  assert.deepEqual(names(parseMakefile(text, 'Makefile')), ['build']);
});

test('a grouped target marker is not a target of its own', () => {
  const { parseMakefile } = harness();
  assert.deepEqual(names(parseMakefile('a b &: c\n\ttouch a b\n', 'Makefile')), ['a', 'b']);
});

test('a justfile recipe is private inside an attribute list too', () => {
  const { parseJustfile } = harness();
  const text = '[private, no-cd]\nsetup-ci:\n  echo\n\n[no-cd, private]\nother:\n  echo\n\nbuild:\n  echo\n';
  assert.deepEqual(names(parseJustfile(text, 'justfile')), ['build']);
});

test('a deno task made only of dependencies is still a row', () => {
  const { parseDenoJson } = harness();
  const text = JSON.stringify({
    tasks: {
      build: { dependencies: ['build:client', 'build:server'] },
      'build:client': 'deno run a.ts',
      'build:server': { command: 'deno run b.ts', description: 'Server' },
    },
  });
  const parsed = plain(parseDenoJson(text));
  assert.deepEqual(parsed.tasks.map((task) => task.name), ['build', 'build:client', 'build:server']);
  assert.equal(parsed.tasks[0].command, 'build:client, build:server');
});

test('a scripts table that is an array names no rows', () => {
  const { parsePackageJson, parseDenoJson } = harness();
  assert.equal(parsePackageJson('{"scripts": ["echo hi", "npm test"]}'), undefined);
  assert.equal(parseDenoJson('{"tasks": ["echo hi"]}'), undefined);
});

test('yarn scripts are run through `yarn run`, never as a bare subcommand', () => {
  const { RUNNERS } = harness();
  assert.deepEqual(plain(RUNNERS.yarn), ['yarn', 'run']);
});

test('a byte-order mark does not hide a manifest', async () => {
  const { readText } = harness({ found: { '/repo/package.json': '\uFEFF{"scripts": {"a": "b"}}' } });
  const text = await readText({ path: '/repo/package.json' });
  assert.equal(text, '{"scripts": {"a": "b"}}');
});

test('a file over the size limit is skipped without being read', async () => {
  const { readText } = harness({ found: { '/repo/package.json': 'x'.repeat(1_000_001) } });
  assert.equal(await readText({ path: '/repo/package.json' }), undefined);
});

test('a Go module root is a program when applicable root files declare its main package and function', async () => {
  const gomod = 'module example.com/app\n';
  const settings = { goCommands: ['run', 'build'] };
  const withServer = harness({
    settings,
    present: ['/repo/server.go'],
    found: { '/repo/server.go': '// Server.\npackage main\n\nfunc main() {}\n' },
    directory: { '/repo': [['server.go', 1], ['go.mod', 1]] },
  });
  assert.deepEqual(names(await withServer.parseGoMod(gomod, { path: '/repo' })), ['run', 'build']);

  const library = harness({
    settings,
    found: {
      '/repo/lib.go': 'package lib\n',
      '/repo/gen.go': '//go:build ignore\n\npackage main\n\nfunc main() {}\n',
      '/repo/doc.go': '/*\npackage main\n*/\npackage lib\n',
    },
    directory: { '/repo': [['lib.go', 1], ['gen.go', 1], ['doc.go', 1], ['lib_test.go', 1]] },
  });
  assert.deepEqual(names(await library.parseGoMod(gomod, { path: '/repo' })), ['build']);
});

// --- a Go module root is a program only when it says so ----------------------

test('a `main.go` that is not `package main` offers no run row', async () => {
  const gomod = 'module example.com/lib\n';
  const settings = { goCommands: ['run', 'build'] };
  // The name is not the clause: a library may keep its own `main.go`, and
  // `go run .` on that fails with "not a main package".
  const library = harness({
    settings,
    found: { '/repo/main.go': 'package library\n\nfunc Run() {}\n' },
    directory: { '/repo': [['main.go', 1]] },
  });
  assert.deepEqual(names(await library.parseGoMod(gomod, { path: '/repo' })), ['build']);

  const program = harness({
    settings,
    found: { '/repo/main.go': 'package main\n\nfunc main() {}\n' },
    directory: { '/repo': [['main.go', 1]] },
  });
  assert.deepEqual(names(await program.parseGoMod(gomod, { path: '/repo' })), ['run', 'build']);
});

test('a crowded module root still finds its `main.go`', async () => {
  // The clause is looked for under a budget of bytes, and `main.go` is read
  // first, so where the listing puts it decides nothing.
  const found = { '/repo/main.go': 'package main\n\nfunc main() {}\n' };
  const listing = [];
  for (let at = 0; at < 60; at++) {
    found[`/repo/z${at}.go`] = `package main_is_not_this\n`;
    listing.push([`z${at}.go`, 1]);
  }
  listing.push(['main.go', 1]);
  const h = harness({ settings: { goCommands: ['run'] }, found, directory: { '/repo': listing } });
  assert.deepEqual(names(await h.parseGoMod('module example.com/app\n', { path: '/repo' })), ['run']);
});

test('package main without a main function is not runnable', async () => {
  const h = harness({
    settings: { goCommands: ['run', 'build'] },
    found: { '/repo/helpers.go': 'package main\n\nfunc helper() {}\n' },
    directory: { '/repo': [['helpers.go', 1]] },
  });
  assert.deepEqual(names(await h.parseGoMod('module example.com/app\n', { path: '/repo' })), ['build']);
});

test('a main function may live in another file of the main package', async () => {
  const h = harness({
    settings: { goCommands: ['run'] },
    found: {
      '/repo/package.go': 'package main\n\nfunc helper() {}\n',
      '/repo/entry.go': 'package main\n\nfunc main() {}\n',
    },
    directory: { '/repo': [['package.go', 1], ['entry.go', 1]] },
  });
  assert.deepEqual(names(await h.parseGoMod('module example.com/app\n', { path: '/repo' })), ['run']);
});

test('a main function for another platform does not make this root runnable', async () => {
  const other = process.platform === 'win32' ? 'linux' : 'windows';
  const file = `entry_${other}.go`;
  const h = harness({
    settings: { goCommands: ['run', 'build'] },
    found: { [`/repo/${file}`]: 'package main\n\nfunc main() {}\n' },
    directory: { '/repo': [[file, 1]] },
  });
  assert.deepEqual(names(await h.parseGoMod('module example.com/app\n', { path: '/repo' })), ['build']);
});

test('a false Go build constraint excludes its main function', async () => {
  const other = process.platform === 'win32' ? 'linux' : 'windows';
  const h = harness({
    settings: { goCommands: ['run', 'build'] },
    found: { '/repo/entry.go': `//go:build ${other}\n\npackage main\n\nfunc main() {}\n` },
    directory: { '/repo': [['entry.go', 1]] },
  });
  assert.deepEqual(names(await h.parseGoMod('module example.com/app\n', { path: '/repo' })), ['build']);
});

test('the Go files are watched apart from the Rust ones', () => {
  const { SOURCE_GLOB, GO_GLOB } = harness();
  // A `.go` file's contents decide a row, so it needs change events the Rust
  // targets must not get — which is only possible from a glob of its own.
  assert.equal(SOURCE_GLOB.includes('.go'), false);
  assert.equal(GO_GLOB, '**/*.go');
});

// --- compose is never asked to detach ----------------------------------------

test('a compose command of your own is never run detached', async () => {
  const { parseCompose } = harness({ settings: { dockerComposeCommands: ['up -d'] } });
  const parsed = plain(await parseCompose(COMPOSE, 'docker-compose.yml', cwd));
  // `-d` would exit the moment it started, leaving the containers up and the
  // square with nothing to stop. The row lands back on plain `up`, services
  // and all, so the mark and the ■ still know what it is.
  assert.deepEqual(
    parsed.tasks.map((task) => task.name),
    ['up', 'up: web', 'up: db', 'down'],
  );
  assert.equal(parsed.tasks[0].argv.includes('-d'), false);
  assert.equal(parsed.tasks[0].argv.at(-1), 'up');
});

test('a detached spelling does not become a second copy of `up`', async () => {
  const { parseCompose } = harness({ settings: { dockerComposeCommands: ['up', 'up --detach'] } });
  const parsed = plain(await parseCompose(COMPOSE, 'docker-compose.yml', cwd));
  assert.deepEqual(parsed.tasks.map((task) => task.name), ['up', 'up: web', 'up: db', 'down']);
});

test('a compose command of your own keeps the flags that are not a detach', async () => {
  const { parseCompose } = harness({ settings: { dockerComposeCommands: ['up --build'] } });
  const parsed = plain(await parseCompose(COMPOSE, 'docker-compose.yml', cwd));
  assert.deepEqual(parsed.tasks.map((task) => task.name), ['up', 'up: web', 'up: db', 'down', 'up --build']);
  assert.deepEqual(parsed.tasks.at(-1).argv.slice(-2), ['up', '--build']);
});

test('compose options that imply detach are removed too', async () => {
  const { parseCompose } = harness({
    settings: { dockerComposeCommands: ['up --wait', 'up --detach=true'] },
  });
  const parsed = plain(await parseCompose(COMPOSE, 'docker-compose.yml', cwd));
  assert.deepEqual(parsed.tasks.map((task) => task.name), ['up', 'up: web', 'up: db', 'down']);
  assert.ok(!parsed.tasks.some((task) => task.argv.some((word) => word.startsWith('--wait'))));
  assert.ok(!parsed.tasks.some((task) => task.argv.some((word) => word.startsWith('--detach'))));
});
