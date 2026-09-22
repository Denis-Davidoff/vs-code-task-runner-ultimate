const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The reader touches nothing outside itself, so it is transpiled and run bare.
const source = fs.readFileSync(path.join(__dirname, '../src/toml.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ exports: {} });
vm.runInContext(compiled, context);
const { parseToml } = context.exports;

test('a line-ending backslash swallows the newline and the indent after it', () => {
  assert.equal(parseToml('run = """cargo build \\\n    --release"""').run, 'cargo build --release');
});

test('whitespace between the backslash and the newline changes nothing', () => {
  // The spec allows it, and an editor that keeps trailing spaces leaves it there.
  assert.equal(parseToml('run = """cargo build \\   \n    --release"""').run, 'cargo build --release');
  assert.equal(parseToml('run = """cargo build \\\t \r\n    --release"""').run, 'cargo build --release');
});
