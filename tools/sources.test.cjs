const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The parsers are module-private, so the file is transpiled and run with a small
// workspace mock that answers the two things a parse can ask the world: what the
// settings say, and whether a file is there.
const source = fs.readFileSync(path.join(__dirname, '../src/sources.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ settings = {}, present = [] } = {}) {
  const onDisk = new Set(present);
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (key) => settings[key] }),
      fs: {
        stat: async (uri) => {
          if (!onDisk.has(uri.path)) {
            throw new Error(`no such file: ${uri.path}`);
          }
          return {};
        },
      },
    },
    Uri: {
      joinPath: (uri, ...parts) => ({ path: [uri.path, ...parts].join('/') }),
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
    exports.parsers = { parseCompose, yamlBlockKeys, shellDescription, composeOverride };
  `,
    context,
  );
  return context.exports.parsers;
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

test('composeOverride names the file compose would have merged', () => {
  const { composeOverride } = harness();
  assert.equal(composeOverride('docker-compose.yml'), 'docker-compose.override.yml');
  assert.equal(composeOverride('compose.yaml'), 'compose.override.yaml');
});
