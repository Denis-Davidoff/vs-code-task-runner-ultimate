const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// `composeState` is the one place this extension starts a process, so the test
// stands where the process would: `child_process` is stubbed and the module is
// judged on what it makes of the bytes it is handed.
const source = fs.readFileSync(path.join(__dirname, '../src/containers.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/**
 * @param reply what the stubbed `execFile` answers: a string, an Error, a
 * function, or an array of those — one per call, for the probes that ask twice.
 */
function harness(reply) {
  const calls = [];
  const execFile = (program, args, options, done) => {
    calls.push({ program, args, options });
    const answer = Array.isArray(reply) ? reply[calls.length - 1] : reply;
    if (typeof answer === 'function') {
      answer(done);
      return;
    }
    setImmediate(() => (answer instanceof Error ? done(answer, '') : done(null, answer ?? '')));
  };
  const context = vm.createContext({
    exports: {},
    setImmediate,
    require: (name) => (name === 'child_process' ? { execFile } : {}),
  });
  vm.runInContext(compiled, context);
  return { composeState: context.exports.composeState, calls };
}

const services = (state) => (state ? [...state.running].sort() : undefined);

// One JSON object per line, which is what compose has emitted since v2.21.
const NDJSON = [
  '{"Name":"acme-web-1","Service":"web","State":"running"}',
  '{"Name":"acme-db-1","Service":"db","State":"running"}',
  '{"Name":"acme-seed-1","Service":"seed","State":"exited"}',
].join('\n');

// A single array, which is what it emitted before that.
const ARRAY = JSON.stringify([
  { Name: 'acme-web-1', Service: 'web', State: 'running' },
  { Name: 'acme-seed-1', Service: 'seed', State: 'exited' },
]);

test('reads the line-delimited shape and keeps only what is up', async () => {
  const h = harness(NDJSON);
  assert.deepEqual(services(await h.composeState(['docker', 'compose', '-f', 'compose.yml'], '/repo')), [
    'db',
    'web',
  ]);
});

test('reads the array shape compose used to emit', async () => {
  const h = harness(ARRAY);
  assert.deepEqual(services(await h.composeState(['docker-compose', '-f', 'compose.yml'], '/repo')), ['web']);
});

test('a restarting service counts as up', async () => {
  const h = harness('{"Service":"web","State":"restarting"}');
  assert.deepEqual(services(await h.composeState(['docker', 'compose'], '/repo')), ['web']);
});

test('the probe asks compose for json, in the compose file’s own directory', async () => {
  const h = harness(NDJSON);
  await h.composeState(['docker', 'compose', '-f', 'compose.yml', '-f', 'compose.override.yml'], '/repo/svc');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].program, 'docker');
  // The prefix it was given, then the question — the `-f`s the parser settled on
  // travel with it, so the probe reads the same files the rows run.
  assert.deepEqual([...h.calls[0].args], [
    'compose',
    '-f',
    'compose.yml',
    '-f',
    'compose.override.yml',
    'ps',
    '--format',
    'json',
  ]);
  assert.equal(h.calls[0].options.cwd, '/repo/svc');
  // A timeout, because a stopped daemon is the ordinary failure and a frozen
  // menu is a worse answer than no answer.
  assert.ok(h.calls[0].options.timeout > 0);
});

test('a docker that cannot answer says nothing, rather than saying "stopped"', async () => {
  // Undefined and not an empty set: the caller keeps its previous answer, so a
  // daemon that is down never makes a running stack look stopped.
  const h = harness(new Error('spawn docker ENOENT'));
  assert.equal(await h.composeState(['docker', 'compose'], '/repo'), undefined);
});

test('output that is not json at all is read as nothing being up', async () => {
  // Asked and answered, just with nothing in it — which is a different fact from
  // not having been able to ask, and is stored as one.
  const h = harness('no configuration file provided\n');
  assert.deepEqual(services(await h.composeState(['docker', 'compose'], '/repo')), []);
});

/** The v1 binary's answer to a flag it does not have. */
function noSuchOption() {
  const error = new Error('no such option: --format');
  error.code = 2;
  return error;
}

test('a compose that has no --format json is asked the way v1 understands', async () => {
  // The standalone v1 binary is still what `dockerCompose: docker-compose` means
  // on plenty of machines, and it rejects `--format` outright — every probe then
  // failed exactly as a stopped daemon does, so no row was ever marked up.
  const h = harness([noSuchOption(), 'web\ndb\n']);
  assert.deepEqual(services(await h.composeState(['docker-compose', '-f', 'compose.yml'], '/repo')), [
    'db',
    'web',
  ]);
  assert.equal(h.calls.length, 2);
  // Filtered, and not a bare `--services`: that lists every service the file
  // declares, which would report a stopped stack as up.
  assert.deepEqual([...h.calls[1].args], [
    '-f',
    'compose.yml',
    'ps',
    '--services',
    '--filter',
    'status=running',
  ]);
});

test('a line that is not a service name is not believed to be one', async () => {
  const h = harness([noSuchOption(), 'WARNING: something\nweb\n\n']);
  assert.deepEqual(services(await h.composeState(['docker-compose'], '/repo')), ['web']);
});

test('a daemon that never answers is not asked a second time', async () => {
  // `killed` is how `execFile` reports its own timeout. Asking again in another
  // spelling would only double the wait a person is sitting through.
  const timeout = new Error('timed out');
  timeout.killed = true;
  const h = harness([timeout, 'web\n']);
  assert.equal(await h.composeState(['docker', 'compose'], '/repo'), undefined);
  assert.equal(h.calls.length, 1);
});

test('a compose that answers json is asked once and only once', async () => {
  const h = harness(NDJSON);
  await h.composeState(['docker', 'compose'], '/repo');
  assert.equal(h.calls.length, 1);
});

test('a program name that cannot be spawned at all is caught', async () => {
  const h = harness((done) => {
    void done;
    throw new TypeError('bad program');
  });
  assert.equal(await h.composeState(['', 'compose'], '/repo'), undefined);
});
