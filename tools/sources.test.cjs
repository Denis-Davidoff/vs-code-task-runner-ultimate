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
function harness({ settings = {}, present = [], found = [], root, directory = {}, folders, broken = [] } = {}) {
  const onDisk = new Set(present);
  const calls = [];
  // What was written, by path, and the directories made on the way.
  const written = {};
  const made = [];
  const contents = found && !Array.isArray(found) ? found : Object.fromEntries((found ?? []).map((at) => [at, '']));
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (key) => settings[key] }),
      getWorkspaceFolder: () => (root ? { uri: uri(root) } : undefined),
      // The folders the custom tasks are read out of, one file each.
      workspaceFolders: folders?.map((at, index) => ({ name: path.posix.basename(at), uri: uri(at), index })),
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
          // A path in `broken` is there and cannot be read — a permission, a
          // remote that dropped. Anything else missing is missing the way
          // VS Code says it: a `FileSystemError` whose code is `FileNotFound`.
          if (broken.includes(target.path)) {
            throw Object.assign(new Error(`no permissions: ${target.path}`), { code: 'NoPermissions' });
          }
          if (!onDisk.has(target.path) && !(target.path in contents)) {
            throw Object.assign(new Error(`no such file: ${target.path}`), { code: 'FileNotFound' });
          }
          return { size: Buffer.byteLength(contents[target.path] ?? '', 'utf8') };
        },
        readFile: async (target) => Buffer.from(contents[target.path] ?? '', 'utf8'),
        readDirectory: async (target) => directory[target.path] ?? [],
        writeFile: async (target, bytes) => {
          written[target.path] = Buffer.from(bytes).toString('utf8');
        },
        createDirectory: async (target) => void made.push(target.path),
      },
    },
    Uri: {
      joinPath: (target, ...parts) => uri([target.path, ...parts].join('/')),
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
    exports.parsers = { parseCompose, parseDockerfile, yamlBlockKeys, shellDescription, manifestKind, collectShellScripts, parseMakefile, parseJustfile, parseDenoJson, parsePackageJson, parseGoMod, parseTaskfile, parseTox, parseCustomTasks, editCustomTasks, readCustomTasks, emptyManifestsOf: exports.emptyManifests, detectPackageManager, nodeHints, collectScripts, resetSources, settingShapedManifests, readText, RUNNERS, SOURCE_GLOB: exports.SOURCE_GLOB, GO_GLOB: exports.GO_GLOB };
  `,
    context,
  );
  return { ...context.exports.parsers, calls, written, made };
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

// Both conventions collapse to the same profile word, so the two files build the
// same reference. Known and documented rather than guarded against: telling them
// apart would need a marker in the tag that nobody would want to read. Use one
// convention per folder.
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

test('every derived reference is one Docker will parse', async () => {
  // Docker's own grammar: a repository component is alphanumeric runs joined by
  // a single `.`/`_`, a `__`, or a run of `-`. A folder may be called anything,
  // so `my..app` and `a___b` used to produce `invalid reference format` on every
  // row of the group.
  const component = /^[a-z0-9]+(?:(?:[._]|__|[-]*)[a-z0-9]+)*$/;
  const tagRe = /^[\w][\w.-]{0,127}$/;
  const valid = (ref) => {
    const [repository, tag] = ref.split(':');
    return repository.split('/').every((part) => component.test(part)) && (tag === undefined || tagRe.test(tag));
  };
  const { parseDockerfile } = harness({ settings: { dockerfileCommands: [] } });
  const ref = async (folder, file = 'Dockerfile') =>
    tagged(plain(await parseDockerfile('FROM scratch\n', file, { path: `/repo/${folder}` })).tasks[0]);

  for (const folder of ['my..app', 'my._app', 'a___b', 'v1..2', '@acme/web', 'MyApp', '@@@']) {
    assert.ok(valid(await ref(folder)), `${folder} -> ${await ref(folder)}`);
  }
  // A dot never survives in the repository half, and that is the point rather
  // than a side effect: Docker reads a first component carrying one as a
  // registry domain, so `push` would have pushed at a real remote.
  assert.equal(await ref('example.com'), 'example-com');
  // The tag half is bounded at 128, which a profile read off a file name is not.
  assert.equal((await ref('api', `Dockerfile.${'a'.repeat(200)}`)).split(':')[1].length, 128);
});

test('an image the user names, or a stage they target, is the one that is built', async () => {
  const at = { path: '/repo/services/api' };
  const commands = async (entry) =>
    plain(
      await harness({ settings: { dockerfileCommands: [entry] } }).parseDockerfile(
        'FROM scratch AS builder\n',
        'Dockerfile',
        at,
      ),
    ).tasks.map((task) => task.command);

  // `-t` of the user's own replaces the derived one. Appended alongside it,
  // `docker build -t acme/api -t api .` applied *both* names — so the documented
  // way of naming an image yourself changed nothing about the name `run` uses.
  assert.deepEqual((await commands('build -t acme/api')).at(-1), 'docker build -f Dockerfile -t acme/api .');
  // A `--target` of the user's own is what the tag is derived for, so an entry
  // that builds one stage cannot land on the whole image's name.
  assert.deepEqual(
    (await commands('build --target builder')).at(-1),
    'docker build -f Dockerfile --target builder -t api/builder .',
  );
  // `push` takes exactly one NAME, so a reference of the user's own replaces the
  // derived one rather than becoming a second positional argument.
  const push = async (entry) =>
    plain(
      await harness({ settings: { dockerfileCommands: [entry] } }).parseDockerfile('FROM scratch\n', 'Dockerfile', {
        path: '/repo/api',
      }),
    ).tasks.at(-1).command;
  assert.equal(await push('push acme/api'), 'docker push acme/api');
  // `--platform` is the one option of `push` that takes a value, so its value is
  // not mistaken for the image.
  assert.equal(await push('push --platform linux/amd64'), 'docker push --platform linux/amd64 api');
});

test('a bundle of short options carrying -d still detaches nothing', async () => {
  const run = async (entry) =>
    plain(
      await harness({ settings: { dockerfileCommands: [entry] } }).parseDockerfile('FROM scratch\n', 'Dockerfile', {
        path: '/repo/api',
      }),
    ).tasks.at(-1).command;
  // `docker run -dit` is in Docker's own documentation, and the `-d` inside it
  // detaches exactly as one on its own would: the row would exit at once, the
  // square would have nothing to stop, and no Check Containers reaches a
  // Dockerfile row.
  assert.equal(await run('run -dit'), 'docker run --rm -it api');
  assert.equal(await run('run -itd'), 'docker run --rm -it api');
  // `--detach-keys` sets a key sequence rather than detaching, and `-D` is
  // `--debug`. Neither is swept up.
  assert.equal(await run('run --detach-keys=ctrl-a'), 'docker run --rm -it --detach-keys=ctrl-a api');
  assert.equal(await run('run -D'), 'docker run --rm -it -D api');
});

test('a file that is about a Dockerfile, or is one waiting to be rendered, is not one', () => {
  const { manifestKind } = harness();
  const kind = (name) => manifestKind({ path: `/repo/${name}` });
  // The `FROM` check cannot turn these away: a template *is* a Dockerfile
  // textually, and a document explaining how to write one quotes a `FROM`.
  for (const name of ['Dockerfile.md', 'Dockerfile.j2', 'Dockerfile.template', 'Dockerfile.orig', 'Dockerfile.rej']) {
    assert.equal(kind(name), undefined, name);
  }
  // The last segment decides, so what a conflicted merge leaves beside
  // `Dockerfile.dev` is refused on the `orig` rather than believed on the `dev`.
  assert.equal(kind('Dockerfile.dev.orig'), undefined);
  assert.equal(kind('Dockerfile.dev'), 'dockerfile');
  // Only the `Dockerfile.<profile>` spelling is tested: in the other convention
  // the word is a name the author chose.
  assert.equal(kind('template.Dockerfile'), 'dockerfile');
});

test('a setting entry cannot collide with a generated stage row', async () => {
  // The generated names are claimed in the same set the entries are, so the
  // scan's own per-manifest de-duplication is never the thing that drops one.
  const { parseDockerfile } = harness({ settings: { dockerfileCommands: ['build: deps'] } });
  const parsed = plain(await parseDockerfile('FROM scratch AS deps\n', 'Dockerfile', { path: '/repo/api' }));
  assert.deepEqual(parsed.tasks.map((task) => task.name), ['build', 'build: deps']);
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

test('a compose command keeps the flags of the command it runs in a container', async () => {
  const { parseCompose } = harness({
    settings: {
      dockerComposeCommands: ['exec web ls -d /tmp', 'run --rm -e CI=1 web pytest -vd', 'run -d web migrate', 'up --scale web=3 -d'],
    },
  });
  const parsed = plain(await parseCompose(COMPOSE, 'docker-compose.yml', cwd));
  const tail = (name) => parsed.tasks.find((task) => task.name === name)?.argv.slice(4);
  // After the service name everything is the container's, so `-d` there is
  // `ls`'s and `-vd` is pytest's.
  assert.deepEqual(tail('exec web ls -d /tmp'), ['exec', 'web', 'ls', '-d', '/tmp']);
  assert.deepEqual(tail('run --rm -e CI=1 web pytest -vd'), ['run', '--rm', '-e', 'CI=1', 'web', 'pytest', '-vd']);
  // Before it the `-d` is compose's, and still goes.
  assert.deepEqual(tail('run web migrate'), ['run', 'web', 'migrate']);
  // `up` takes its options anywhere, so its `-d` goes wherever it stands.
  assert.deepEqual(tail('up --scale web=3'), ['up', '--scale', 'web=3']);
});

// --- Go build constraints, as go/build reads them -----------------------------

test('a Go file named after a platform with nothing before it is built everywhere', async () => {
  const other = process.platform === 'win32' ? 'linux' : 'windows';
  const h = harness({
    settings: { goCommands: ['run'] },
    found: { [`/repo/${other}.go`]: 'package main\n\nfunc main() {}\n' },
    directory: { '/repo': [[`${other}.go`, 1]] },
  });
  assert.deepEqual(names(await h.parseGoMod('module example.com/app\n', { path: '/repo' })), ['run']);
});

test('release tags are met up to the module\'s own go line, and cgo is never assumed', async () => {
  const run = async (constraint, gomod = 'module example.com/app\n\ngo 1.22\n') =>
    names(
      await harness({
        settings: { goCommands: ['run'] },
        found: { '/repo/main.go': `${constraint}\n\npackage main\n\nfunc main() {}\n` },
        directory: { '/repo': [['main.go', 1]] },
      }).parseGoMod(gomod, { path: '/repo' }),
    );
  const here = process.platform === 'win32' ? 'windows' : process.platform;
  // Any toolchain that builds a `go 1.22` module has reached 1.21 and 1.22.
  assert.deepEqual(await run('//go:build go1.21'), ['run']);
  assert.deepEqual(await run('//go:build go1.22'), ['run']);
  assert.deepEqual(await run('//go:build !go1.21'), []);
  // Past that line nothing is known, so the row is the one left out.
  assert.deepEqual(await run('//go:build go1.999'), []);
  assert.deepEqual(await run('//go:build go1.21', 'module example.com/app\n'), []);
  // `CGO_ENABLED=0`, or no C compiler, is indistinguishable from on.
  assert.deepEqual(await run('//go:build cgo'), []);
  assert.deepEqual(await run('//go:build !cgo'), ['run']);
  assert.deepEqual(await run(`//go:build ignore || ${here}`), ['run']);
  assert.deepEqual(await run('//go:build ignore'), []);
  assert.deepEqual(await run('// +build ignore'), []);
});

// --- Taskfile descriptions ------------------------------------------------------

test('a Taskfile block scalar is described by its first line, and desc wins over summary', () => {
  const { parseTaskfile } = harness();
  const text = [
    'version: "3"',
    'tasks:',
    '  release:',
    '    summary: |',
    '      Release your project to GitHub.',
    '',
    '      It tags and uploads.',
    '    cmds:',
    '      - goreleaser',
    '  build:',
    '    summary: Long form of build',
    '    desc: >-',
    '      Build the binary',
    '  lint:',
    '    desc: "Run the linters"',
  ].join('\n');
  const parsed = plain(parseTaskfile(text, 'Taskfile.yml'));
  assert.deepEqual(
    parsed.tasks.map((task) => [task.name, task.command]),
    [
      ['release', 'Release your project to GitHub.'],
      ['build', 'Build the binary'],
      ['lint', 'Run the linters'],
    ],
  );
});

// --- tox ------------------------------------------------------------------------

test('a generative tox section name is opened into the environments it declares', () => {
  const { parseTox } = harness();
  const text = [
    '[tox]',
    'envlist = py{310,311}, lint',
    '[testenv]',
    'commands = pytest',
    '[testenv:{lint,format}]',
    'commands = ruff check',
    '[testenv:py{310,311}-django]',
    'deps = django',
    '[testenv:docs]',
    'description = Build the docs',
  ].join('\n');
  // The header is tox declaring environments, so it is opened into them; the
  // `envlist` matrix is still left alone.
  assert.deepEqual(names(parseTox(text)), ['lint', 'format', 'py310-django', 'py311-django', 'docs']);
  const lint = plain(parseTox('[testenv:{lint, format}]\ndescription = Lint it\n')).tasks;
  assert.deepEqual(lint.map((task) => [task.name, task.command, task.argv.at(-1)]), [
    ['lint', 'Lint it', 'lint'],
    ['format', 'Lint it', 'format'],
  ]);
});

// --- package manager detection ------------------------------------------------

test('a lock file names the runner before `engines` does, and `engines.npm` names none', async () => {
  const detect = async ({ engines, present }) => {
    const h = harness({ root: '/repo', present });
    h.nodeHints.set('file:///repo/package.json', { engines });
    const entry = { kind: 'npm', manifest: uri('/repo/package.json'), cwd: uri('/repo') };
    return h.detectPackageManager(entry, new Map());
  };
  // `"npm": ">=9"` says which npm is too old, not that npm runs the scripts.
  assert.equal(await detect({ engines: { node: '>=18', npm: '>=9' }, present: ['/repo/pnpm-lock.yaml'] }), 'pnpm');
  assert.equal(await detect({ engines: { pnpm: '>=9' }, present: ['/repo/yarn.lock'] }), 'yarn');
  // With no lock file, `engines` is still the hint it was.
  assert.equal(await detect({ engines: { pnpm: '>=9' }, present: [] }), 'pnpm');
  assert.equal(await detect({ engines: { npm: '>=9' }, present: [] }), undefined);
});

test('the lock-file walk asks each directory once per scan', async () => {
  const h = harness({ root: '/repo', present: ['/repo/pnpm-lock.yaml'] });
  let stats = 0;
  const lockFiles = new Map();
  for (const name of ['a', 'b', 'c']) {
    const before = lockFiles.size;
    await h.detectPackageManager(
      { kind: 'npm', manifest: uri(`/repo/packages/${name}/package.json`), cwd: uri(`/repo/packages/${name}`) },
      lockFiles,
    );
    stats += lockFiles.size - before;
  }
  // Three package directories, then `packages` and the root once between them.
  assert.equal(stats, 5);
});

// --- what a scan learnt travels with its own rows ---------------------------------

test('a scan cut short by a reset still answers for the rows it hands back', async () => {
  // The prune runs on whatever list the caller was given. A reset during the
  // walk must not leave that list with nobody saying which of its manifests a
  // setting shapes — that would read the go.mod as a file whose rows are all
  // its own, and drop the star on the row `goCommands` just hid.
  const h = harness({
    root: '/repo',
    settings: { goCommands: ['build'] },
    found: { '/repo/go.mod': 'module example.com/app\n' },
    directory: { '/repo': [['go.mod', 1]] },
  });
  const scan = h.collectScripts();
  h.resetSources();
  const rows = await scan;
  assert.deepEqual(plain(rows.map((row) => row.name)), ['build']);
  const shaped = h.settingShapedManifests(rows);
  assert.equal(shaped.length, 1);
  assert.equal(shaped[0][0].path, '/repo/go.mod');
  assert.equal(shaped[0][1]('test'), true);
});

test('a Makefile rule named `define-…` does not swallow the rules after it', () => {
  const { parseMakefile } = harness();
  const text = [
    'define-docs: ## generate docs',
    '\techo',
    'export define BANNER',
    'banner: not a rule',
    'endef',
    'build: ## build it',
    '\tgo build',
  ].join('\n');
  assert.deepEqual(names(parseMakefile(text, 'Makefile')), ['define-docs', 'build']);
});

test('a bundle of short options loses its `d` and keeps the rest', async () => {
  const { parseCompose } = harness({
    settings: { dockerComposeCommands: ['exec -dT web ./migrate', 'run -dit web sh', 'run -edev web env'] },
  });
  const parsed = plain(await parseCompose(COMPOSE, 'docker-compose.yml', cwd));
  const tails = parsed.tasks.slice(4).map((task) => task.argv.slice(4).join(' '));
  // `-T` and `-it` are not a detach and survive it; the `d` of `-edev` is the
  // value of `-e`, not an option at all.
  assert.deepEqual(tails, ['exec -T web ./migrate', 'run -it web sh', 'run -edev web env']);

  const dockerfile = async (entry) =>
    plain(
      await harness({ settings: { dockerfileCommands: [entry] } }).parseDockerfile('FROM scratch\n', 'Dockerfile', {
        path: '/repo/api',
      }),
    ).tasks.at(-1).command;
  // A capital letter in the bundle no longer hides the `d` beside it.
  assert.equal(await dockerfile('run -dP'), 'docker run --rm -it -P api');
});

test('a Taskfile description is the task\'s own, and an empty block has none', () => {
  const { parseTaskfile } = harness();
  const text = [
    'version: "3"',
    'tasks:',
    '  empty:',
    '    summary: |',
    '    cmds:',
    '      - echo',
    '  nested:',
    '    requires:',
    '      - desc: not this one',
    '    vars:',
    '      desc: nor this',
    '    cmds:',
    '      - echo',
  ].join('\n');
  const parsed = plain(parseTaskfile(text, 'Taskfile.yml'));
  assert.deepEqual(
    parsed.tasks.map((task) => [task.name, task.command]),
    [
      ['empty', 'task empty'],
      ['nested', 'task nested'],
    ],
  );
});

// --- custom tasks ------------------------------------------------------------

const CUSTOM = '/repo/.vscode/task-script-explorer.json';

test('a custom tasks file is a name-to-command map, and nothing else is a task', () => {
  const { parseCustomTasks } = harness();
  const text = [
    '{',
    '  // hand-written, so comments and trailing commas are fine',
    '  "tasks": {',
    '    "Reset DB": "docker compose down -v && docker compose up -d db",',
    '    "blank": "   ",',
    '    "number": 3,',
    '    "": "echo nameless",',
    '    "Tail": "tail -f log | grep ERROR",',
    '  },',
    '}',
  ].join('\n');
  assert.deepEqual(plain(parseCustomTasks(text)), [
    ['Reset DB', 'docker compose down -v && docker compose up -d db'],
    ['Tail', 'tail -f log | grep ERROR'],
  ]);
  // A file of ours with no tasks in it is an empty list; one that is not ours is none.
  assert.deepEqual(plain(parseCustomTasks('{}')), []);
  assert.equal(parseCustomTasks('[1, 2]'), undefined);
  assert.equal(parseCustomTasks('{ "tasks": '), undefined);
});

test('the scan reads each folder\'s custom tasks first, whatever `sources` says', async () => {
  const h = harness({
    folders: ['/repo'],
    root: '/repo',
    settings: { sources: [] },
    found: { [CUSTOM]: '{ "tasks": { "Tail": "tail -f  log | grep ERROR" } }' },
  });
  h.resetSources();
  const [row, ...rest] = plain(await h.collectScripts());
  assert.equal(rest.length, 0);
  assert.equal(row.kind, 'custom');
  assert.equal(row.name, 'Tail');
  // The line as typed, for the shell; the dimmed text squeezed to one line.
  assert.equal(row.line, 'tail -f  log | grep ERROR');
  assert.equal(row.command, 'tail -f log | grep ERROR');
  // Run from the folder root, not from `.vscode` where the file is.
  assert.equal(row.cwd.path, '/repo');
  assert.equal(row.packageName, 'Custom Tasks');
  // Read off its known path, not found: `findFiles` never asked for it.
  assert.equal(h.calls.some((call) => String(call.include).includes('task-script-explorer')), false);
});

test('writing custom tasks keeps what else the file holds, and makes `.vscode` if it must', async () => {
  const h = harness({ found: { [CUSTOM]: '{ "note": "mine", "tasks": { "a": "echo a" } }' } });
  const folder = { name: 'repo', uri: uri('/repo') };
  // The text it wrote comes back, which is how the watcher knows its own write.
  assert.equal(await h.editCustomTasks(folder, (tasks) => [...tasks, ['b', 'echo b']]), h.written[CUSTOM]);
  assert.deepEqual(JSON.parse(h.written[CUSTOM]), { note: 'mine', tasks: { a: 'echo a', b: 'echo b' } });
  assert.deepEqual(plain(h.made), ['/repo/.vscode']);
  // An edit that answers nothing writes nothing.
  const quiet = harness({ found: { [CUSTOM]: '{}' } });
  assert.equal(await quiet.editCustomTasks(folder, () => undefined), undefined);
  assert.deepEqual(plain(quiet.written), {});
});

test('a custom tasks file that is not JSON is refused, not written over', async () => {
  const h = harness({ found: { [CUSTOM]: '{ "tasks": { "a": "echo a", ' } });
  const folder = { name: 'repo', uri: uri('/repo') };
  await assert.rejects(h.editCustomTasks(folder, (tasks) => [...tasks, ['b', 'echo b']]), /not a JSON object/);
  assert.deepEqual(plain(h.written), {});
});

test('what the reader skips is still in the file after the tree writes it', async () => {
  const h = harness({
    found: {
      [CUSTOM]: '{ "tasks": { "build": "make", "wip": "", "deploy": { "cmd": "x" }, "test": "make test" } }',
    },
  });
  const folder = { name: 'repo', uri: uri('/repo') };
  // Delete `build`, rename `test`, add one: the skipped members keep their places.
  await h.editCustomTasks(folder, (tasks) => [
    ...tasks.filter(([name]) => name !== 'build').map(([name, line]) => [name === 'test' ? 'check' : name, line]),
    ['lint', 'make lint'],
  ]);
  assert.deepEqual(Object.entries(JSON.parse(h.written[CUSTOM]).tasks), [
    ['check', 'make test'],
    ['wip', ''],
    ['deploy', { cmd: 'x' }],
    ['lint', 'make lint'],
  ]);
});

test('a `tasks` that is not an object is refused, not replaced', async () => {
  const h = harness({ found: { [CUSTOM]: '{ "tasks": ["make"] }' } });
  const folder = { name: 'repo', uri: uri('/repo') };
  await assert.rejects(h.editCustomTasks(folder, (tasks) => [...tasks, ['b', 'echo b']]), /is not an object/);
  assert.deepEqual(plain(h.written), {});
});

test('tasks named like numbers stay where the file puts them, read and written', async () => {
  const text = '{ "tasks": { "setup": "a", "teardown": "b", "2024-report": "c", "1": "d" } }';
  const h = harness({ found: { [CUSTOM]: text } });
  assert.deepEqual(
    plain(h.parseCustomTasks(text)).map(([name]) => name),
    ['setup', 'teardown', '2024-report', '1'],
  );
  const folder = { name: 'repo', uri: uri('/repo') };
  await h.editCustomTasks(folder, (tasks) => tasks.map(([name, line]) => [name === 'teardown' ? '2' : name, line]));
  // Read back by key order in the text, since `JSON.parse` would reorder it.
  const written = h.written[CUSTOM];
  assert.deepEqual(
    plain(h.parseCustomTasks(written)).map(([name]) => name),
    ['setup', '2', '2024-report', '1'],
  );
  assert.ok(written.indexOf('"setup"') < written.indexOf('"2"'));
});

test('a folder\'s tasks are read fresh off the file, and a broken file answers nothing', async () => {
  const folder = { name: 'repo', uri: uri('/repo') };
  assert.deepEqual(plain(await harness({ found: {} }).readCustomTasks(folder)), []);
  assert.deepEqual(plain(await harness({ found: { [CUSTOM]: '{ "tasks": { "a": "b" } }' } }).readCustomTasks(folder)), [['a', 'b']]);
  assert.equal(await harness({ found: { [CUSTOM]: '{ nope' } }).readCustomTasks(folder), undefined);
});

test('a custom tasks file too large to read is refused, not written over as if it were empty', async () => {
  const big = `{ "tasks": { "keep": "echo keep" }, "x": "${'y'.repeat(1_000_001)}" }`;
  const h = harness({ found: { [CUSTOM]: big } });
  const folder = { name: 'repo', uri: uri('/repo') };
  await assert.rejects(h.editCustomTasks(folder, (tasks) => [...tasks, ['new', 'echo new']]), /could not be read/);
  assert.deepEqual(plain(h.written), {});
  // And the prompts do not read it as a folder with no tasks either.
  assert.equal(await h.readCustomTasks(folder), undefined);
});

test('a custom tasks file whose read fails is refused; only a missing one starts from nothing', async () => {
  const folder = { name: 'repo', uri: uri('/repo') };
  const failing = harness({ broken: [CUSTOM] });
  await assert.rejects(failing.editCustomTasks(folder, (tasks) => [...tasks, ['a', 'b']]), /could not be read/);
  assert.equal(await failing.readCustomTasks(folder), undefined);
  const missing = harness({});
  await missing.editCustomTasks(folder, (tasks) => [...tasks, ['a', 'b']]);
  assert.deepEqual(JSON.parse(missing.written[CUSTOM]), { tasks: { a: 'b' } });
});

test('a `tasks` that is not an object is not an emptied list, so the scan does not mark the file blank', async () => {
  for (const tasks of ['null', '[]', '"x"']) {
    const h = harness({ folders: ['/repo'], root: '/repo', found: { [CUSTOM]: `{ "tasks": ${tasks} }` } });
    assert.equal(h.parseCustomTasks(`{ "tasks": ${tasks} }`), undefined, tasks);
    h.resetSources();
    const scan = await h.collectScripts();
    // Blank would tell the prune the folder's tasks were deleted.
    assert.deepEqual(plain(h.emptyManifestsOf(scan)), [], tasks);
    assert.equal(await h.readCustomTasks({ name: 'repo', uri: uri('/repo') }), undefined, tasks);
  }
});

test('a root key written twice is written back once', async () => {
  const h = harness({ found: { [CUSTOM]: '{ "tasks": { "a": "1" }, "x": 1, "tasks": { "b": "2" }, "x": 2 }' } });
  const folder = { name: 'repo', uri: uri('/repo') };
  await h.editCustomTasks(folder, (tasks) => [...tasks, ['c', '3']]);
  const written = h.written[CUSTOM];
  assert.equal(written.match(/"tasks"/g).length, 1);
  assert.equal(written.match(/"x"/g).length, 1);
  assert.deepEqual(JSON.parse(written), { tasks: { b: '2', c: '3' }, x: 2 });
});
