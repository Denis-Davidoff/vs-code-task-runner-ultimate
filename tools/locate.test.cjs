const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// `locateTask` reads the patterns the parsers match with, so the scan module is
// loaded for real — a copy of a regex here would be a second one to keep in step.
const transpile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const sources = vm.createContext({ exports: {}, Buffer, process, require: (name) => (name === 'path' ? path : {}) });
vm.runInContext(transpile('sources.ts'), sources);
const toml = vm.createContext({ exports: {} });
vm.runInContext(transpile('toml.ts'), toml);
const context = vm.createContext({
  exports: {},
  require: (name) => ({ './sources': sources.exports, './toml': toml.exports })[name] ?? {},
});
vm.runInContext(transpile('locate.ts'), context);
const { locateTask } = context.exports;

test('a Makefile target is not found inside a define block', () => {
  const text = [
    'define HELP',
    'build: Build the project',
    'endef',
    '',
    'build:',
    '\tgo build ./...',
  ].join('\n');
  assert.equal(locateTask(text, 'make', 'build')?.line, 4);
});

test('a rule named like the directive is a rule, not the start of a define', () => {
  const text = ['define-docs: ## generate docs', '\techo', 'build:', '\tgo build ./...'].join('\n');
  assert.equal(locateTask(text, 'make', 'build')?.line, 2);
  assert.equal(locateTask(text, 'make', 'define-docs')?.line, 0);
});

test('a tox environment declared by a braced header is found on that header', () => {
  const text = ['[tox]', 'envlist = py311', '', '[testenv:{lint,format}]', 'commands = ruff'].join('\n');
  const found = locateTask(text, 'tox', 'format');
  assert.equal(found?.line, 3);
  assert.equal(text.split('\n')[3].slice(found.character, found.character + found.length), 'format');
});

test('a custom task is found on its key in the tasks object', () => {
  const text = ['{', '  "tasks": {', '    "Reset DB": "docker compose down -v",', '    "Tail": "tail -f log"', '  }', '}'].join('\n');
  const found = locateTask(text, 'custom', 'Tail');
  assert.equal(found?.line, 3);
  assert.equal(text.split('\n')[3].slice(found.character, found.character + found.length), 'Tail');
});

test('a TOML table header quoted inside a multiline string is not the table', () => {
  const text = [
    '[tasks.help]',
    'description = """',
    'Run it as:',
    '[tasks.build]',
    '"""',
    "notes = '''",
    '[tasks.build]',
    "'''",
    'script = "echo"',
    '',
    '[tasks.build]',
    'run = "cargo build"',
  ].join('\n');
  assert.equal(locateTask(text, 'mise', 'build')?.line, 10);
});

test('a triple quote inside a one-line string or a comment does not open a multiline string', () => {
  const text = ['[tasks.a]', 'run = "echo \\"\\"\\""  # """', '', '[tasks.build]', 'run = "x"'].join('\n');
  assert.equal(locateTask(text, 'mise', 'build')?.line, 3);
});

test('a JSONC key with a comment before its colon is still a key', () => {
  const text = ['{', '  "tasks" /* the runner */ : {', '    "build" // why', '      : "deno run"', '  }', '}'].join('\n');
  const found = locateTask(text, 'deno', 'build');
  assert.equal(found?.line, 2);
  assert.equal(text.split('\n')[2].slice(found.character, found.character + found.length), 'build');
});

test('a JSON key spelled with escapes is found by the name it decodes to', () => {
  const text = ['{', '  "scripts": {', '    "bui\\u006cd": "tsc",', '    "a\\/b": "x"', '  }', '}'].join('\n');
  assert.equal(locateTask(text, 'npm', 'build')?.line, 2);
  assert.equal(locateTask(text, 'npm', 'a/b')?.line, 3);
});

/** The text a location selects on its line. */
const selected = (text, found) => text.split('\n')[found.line].slice(found.character, found.character + found.length);

test('a short name is selected where it is the key, not inside a longer word', () => {
  const cases = [
    ['[tasks.a]\nrun = "x"', 'mise', 'a', 0, 7],
    ['tasks.s.run = "x"', 'mise', 's', 0, 6],
    ['[tool.poe.tasks.o]\ncmd = "x"', 'pyproject', 'o', 0, 16],
    ['all a:\n\techo', 'make', 'a', 0, 4],
    ['a.o a:\n\techo', 'make', 'a', 0, 4],
    ['@nox.session\ndef e(session):\n    pass', 'nox', 'e', 1, 4],
  ];
  for (const [text, kind, name, line, character] of cases) {
    assert.deepEqual({ ...locateTask(text, kind, name) }, { line, character, length: name.length }, `${kind} ${name}`);
  }
});

test('a duplicated JSON key is found at its last occurrence, the one JSON.parse keeps', () => {
  const text = '{"scripts":{"build":"a","build":"b"}}';
  assert.equal(locateTask(text, 'npm', 'build')?.character, 25);
});

test('a key under a duplicated table is looked for in the last table only', () => {
  const text = ['{', '  "scripts": { "build": "a" },', '  "scripts": { "test": "b" }', '}'].join('\n');
  assert.equal(locateTask(text, 'npm', 'build'), undefined);
  assert.equal(locateTask(text, 'npm', 'test')?.line, 2);
});

test('a quoted TOML key is read the way the parser reads it', () => {
  assert.equal(locateTask('[tasks]\n"a=b" = "x"', 'mise', 'a=b')?.line, 1);
  assert.equal(locateTask('[tasks."a]b"]\nrun = "x"', 'mise', 'a]b')?.line, 0);
  const escaped = '[tasks]\n"a\\u0062" = "x"';
  const found = locateTask(escaped, 'mise', 'ab');
  assert.equal(found?.line, 1);
  assert.equal(selected(escaped, found), 'a\\u0062');
});
