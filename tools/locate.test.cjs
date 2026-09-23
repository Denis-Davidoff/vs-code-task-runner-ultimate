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
const context = vm.createContext({
  exports: {},
  require: (name) => (name === './sources' ? sources.exports : {}),
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
