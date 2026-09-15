const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Load the extension with a small task-system mock; keep lifecycle functions
// intact and replace only UI, confirmation and process-launch boundaries.
const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness() {
  const listeners = new Set();
  const launches = [];
  const tasks = {
    taskExecutions: [],
    onDidEndTask(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    executeTask: async (task) => launches.push(task),
  };
  const vscode = { tasks, EventEmitter: class {}, window: {
    showWarningMessage: () => assert.fail('Unexpected stop timeout'),
  } };
  const repaints = [];
  const context = vm.createContext({
    exports: {}, setTimeout, clearTimeout, launches, repaints,
    require: (name) => name === 'vscode' ? vscode : name === 'path' ? path : {},
  });
  vm.runInContext(compiled + `
    onStateChanged = () => repaints.push(1);
    confirmScript = async () => true;
    startScript = async (script) => launches.push(script);
    keyForTask = (task) => task.definition.key;
    exports.lifecycle = {
      running, executionOf, stopExecution, stopNode, restartNode, markEnded,
    };
  `, context);
  const api = context.exports.lifecycle;
  function execution() {
    const run = {
      task: { name: 'dev', source: 'scripts', scope: 1, definition: { key: 'dev' } },
      terminate() {
        tasks.taskExecutions = tasks.taskExecutions.filter((item) => item !== run);
        for (const listener of [...listeners]) listener({ execution: run });
      },
    };
    return run;
  }
  return { ...api, tasks, launches, execution, listeners, repaints };
}

test('restart discards an absent execution and starts the script', async () => {
  const h = harness();
  const stale = h.execution();
  stale.terminate = () => assert.fail('Must not terminate a stale handle');
  h.running.set('dev', stale);
  const script = { key: 'dev' };
  await h.restartNode({ kind: 'script', script }, false);
  assert.deepEqual(h.launches, [script]);
  assert.equal(h.running.size, 0);
});

test('stop tolerates a task ending while confirmation is open', async () => {
  const h = harness();
  const stale = h.execution();
  stale.terminate = () => assert.fail('Must not terminate an ended task');
  h.running.set('dev', stale);
  assert.equal(await h.stopExecution(stale), true);
  assert.equal(h.running.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('an end event takes precedence over a lagging task listing', async () => {
  const h = harness();
  const ended = h.execution();
  ended.terminate = () => assert.fail('Must not terminate an ended task');
  h.tasks.taskExecutions = [ended];
  h.markEnded(ended);
  assert.equal(await h.stopExecution(ended), true);
});

test('restart uses the current handle and waits for its end before launching', async () => {
  const h = harness();
  const stale = h.execution();
  stale.terminate = () => assert.fail('Must use the current handle');
  const current = h.execution();
  const terminate = current.terminate;
  current.terminate = () => {
    assert.equal(h.launches.length, 0);
    assert.equal(h.listeners.size, 1);
    terminate();
  };
  h.tasks.taskExecutions = [current];
  await h.restartNode({ kind: 'foreign', execution: stale }, false);
  assert.deepEqual(h.launches, [stale.task]);
  assert.equal(h.tasks.taskExecutions.length, 0);
  assert.equal(h.listeners.size, 0);
});

test('a stale row is idle when deciding whether a click should start it', () => {
  const h = harness();
  h.running.set('dev', h.execution());
  assert.equal(h.executionOf({ kind: 'script', script: { key: 'dev' } }), undefined);
  assert.equal(h.executionOf({ kind: 'foreign', execution: h.execution() }), undefined);
});

test('stopping one of two runs of a task stops the one it was given', async () => {
  const h = harness();
  const first = h.execution();
  const second = h.execution();
  first.terminate = () => assert.fail('Must not stop the other run of the task');
  h.tasks.taskExecutions = [first, second];
  assert.equal(await h.stopExecution(second), true);
  assert.deepEqual(h.tasks.taskExecutions, [first]);
});

test('the other run of a task ending is not the end of this one', async () => {
  // Two runs of one task up (`instanceLimit`, a watch started twice): the end
  // event of the survivor's sibling must not resolve the stop, or a restart
  // would raise a copy beside a run still holding its port.
  const h = harness();
  const first = h.execution();
  const second = h.execution();
  const endSecond = second.terminate;
  second.terminate = () => first.terminate();
  h.tasks.taskExecutions = [first, second];
  let settled = false;
  const stopping = h.stopExecution(second).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'the first run ending does not end the second');
  endSecond();
  assert.equal(await stopping, true);
  assert.deepEqual(h.tasks.taskExecutions, []);
});

test('a foreign row resolves to its own run, not another of the same task', () => {
  const h = harness();
  const first = h.execution();
  const second = h.execution();
  h.tasks.taskExecutions = [first, second];
  assert.equal(h.executionOf({ kind: 'foreign', execution: second }), second);
  assert.equal(h.executionOf({ kind: 'foreign', execution: first }), first);
});

test('a stale handle still resolves to the run the task system lists', () => {
  const h = harness();
  const current = h.execution();
  h.tasks.taskExecutions = [current];
  assert.equal(h.executionOf({ kind: 'foreign', execution: h.execution() }), current);
});

test('stopping a stale row repaints it instead of leaving it spinning', async () => {
  const h = harness();
  h.running.set('dev', h.execution());
  await h.stopNode({ kind: 'script', script: { key: 'dev' } });
  assert.equal(h.running.size, 0);
  assert.ok(h.repaints.length > 0, 'the dropped row must ask for a repaint');
});

test('a stale foreign row repaints when its stop button finds nothing', async () => {
  const h = harness();
  await h.stopNode({ kind: 'foreign', execution: h.execution() });
  assert.ok(h.repaints.length > 0, 'the vanished row must ask for a repaint');
});
