const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const text = fs.readFileSync(path.join(__dirname, '../src/aiContext.ts'), 'utf8');
const context = vm.createContext({ exports: {}, require: (name) => (name === 'vscode' ? {} : require(name)) });
vm.runInContext(
  ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  context,
);
const { usedVariables, substitute } = context.exports;

test('a prompt names the context it wants, each once', () => {
  assert.deepEqual([...usedVariables('Review ${gitDiff}, then ${selection} and ${gitDiff} again; ${nope}')], ['gitDiff', 'selection']);
  assert.deepEqual([...usedVariables('nothing here')], []);
});

test('context goes in once: a value that holds a variable is text, not another substitution', () => {
  assert.equal(
    substitute('A ${selection} B ${clipboard}', { selection: 'has ${clipboard} in it', clipboard: 'SECRET' }),
    'A has ${clipboard} in it B SECRET',
  );
  // One this does not know is left as written.
  assert.equal(substitute('${unknown} ${file}', { file: 'f' }), '${unknown} f');
});

test('a value too large to send is cut, and says so', () => {
  const out = substitute('${gitDiff}', { gitDiff: 'x'.repeat(200_010) });
  assert.equal(out.length < 200_100, true);
  assert.match(out, /\[… 10 more characters cut\]$/);
});
