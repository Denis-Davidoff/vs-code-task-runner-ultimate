const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The runner, run for real: a command line through the shell, a stand-in for
// Copilot's CLI that prints the events the real one does, and a local server
// that answers the way an OpenAI-compatible API does. Only the editor is a stub.
const compile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

function load(file, requireFor) {
  const context = vm.createContext({
    exports: {},
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    fetch,
    AbortController,
    AbortSignal,
    TextDecoder,
    require: requireFor,
  });
  vm.runInContext(compile(file), context);
  return context.exports;
}

const aiTask = load('aiTask.ts', () => ({}));

function harness({ paths = {}, providers = {}, keys = {}, clipboard = '' } = {}) {
  const shown = { errors: [], infos: [], clipboard: [], commands: [] };
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (listener) => this.listeners.push(listener);
    }
    fire(value) {
      for (const listener of this.listeners) listener(value);
    }
  }
  const vscode = {
    EventEmitter,
    workspace: {
      getConfiguration: () => ({ get: (key) => (key === 'aiAgentPaths' ? paths : key === 'aiProviders' ? providers : undefined) }),
      getWorkspaceFolder: () => undefined,
      fs: {
        createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
        writeFile: async (uri, bytes) => fs.writeFileSync(uri.fsPath, bytes),
      },
    },
    extensions: { getExtension: () => undefined },
    window: {
      activeTextEditor: undefined,
      showErrorMessage: async (message) => void shown.errors.push(message),
      showInformationMessage: async (message) => void shown.infos.push(message),
    },
    commands: { executeCommand: async (...args) => void shown.commands.push(args) },
    env: {
      clipboard: {
        readText: async () => clipboard,
        writeText: async (text) => void shown.clipboard.push(text),
      },
    },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  };
  const context = load('aiContext.ts', (name) => (name === 'vscode' ? vscode : require(name)));
  const ai = load('ai.ts', (name) =>
    name === 'vscode' ? vscode : name === './aiTask' ? aiTask : name === './aiContext' ? context : require(name),
  );
  // A key is kept with the address it was saved for: `keys` gives each one for
  // the address the provider has in `providers`, unless the test says otherwise.
  ai.setSecretStorage({
    get: async (name) => {
      const provider = name.replace(/^aiProviderKey:/, '');
      const key = keys[provider];
      if (key === undefined) return undefined;
      return typeof key === 'string' ? JSON.stringify({ key, baseUrl: providers[provider]?.baseUrl }) : JSON.stringify(key);
    },
    store: async () => {},
    delete: async () => {},
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-run-'));
  ai.setReportsRoot({ fsPath: scratch });

  /** Runs a task to its end, and says how it ended and what it wrote. */
  function run(fields, { stopAfter } = {}) {
    const task = aiTask.parseAiTask({ result: 'clipboard', notify: 'none', ...fields });
    assert.ok(task, 'the task is a task');
    const problems = [];
    const runner = new ai.AiRun({
      key: 'k',
      name: 'T',
      task,
      cwd: scratch,
      onAgentProblem: (problem, detail) => problems.push({ problem, detail }),
    });
    let output = '';
    runner.onDidWrite((text) => (output += text));
    return new Promise((resolve) => {
      runner.onDidClose((code) =>
        // The answer is delivered after the task ends.
        setTimeout(() => resolve({ code, output: output.replace(/\x1b\[[0-9;]*m/g, ''), problems }), 100),
      );
      runner.open();
      if (stopAfter) setTimeout(() => runner.handleInput('\x03'), stopAfter);
    });
  }
  return { ai, run, shown, scratch };
}

test('a command of the user\'s own is handed the prompt, context in, and what it prints is the answer', async () => {
  const h = harness({ clipboard: 'world' });
  const { code } = await h.run({ agent: 'command', command: 'tr a-z A-Z', prompt: 'hello ${clipboard}' });
  assert.equal(code, 0);
  assert.deepEqual(h.shown.clipboard, ['HELLO WORLD']);
});

test('a command that fails says so, and delivers nothing', async () => {
  const h = harness();
  const { code } = await h.run({ agent: 'command', command: 'echo broken >&2; exit 3', prompt: 'x' });
  assert.equal(code, 3);
  assert.deepEqual(h.shown.clipboard, []);
  assert.match(h.shown.errors[0], /broken/);
});

/** A stand-in for Copilot's CLI: it says who it is, keeps its arguments, and prints `events`. */
function fakeCopilot(events, { exit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-copilot-'));
  const program = path.join(dir, 'copilot');
  const lines = events.map((event) => JSON.stringify(event)).join('\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines}\n`);
  fs.writeFileSync(
    program,
    [
      '#!/bin/sh',
      'for a in "$@"; do if [ "$a" = "--version" ]; then echo "GitHub Copilot CLI 1.0.98."; exit 0; fi; done',
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `cat > "${dir}/stdin"`,
      `env > "${dir}/env"`,
      `cat "${dir}/events.jsonl"`,
      `exit ${exit}`,
    ].join('\n'),
  );
  fs.chmodSync(program, 0o755);
  return {
    program,
    args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n'),
    stdin: () => fs.readFileSync(path.join(dir, 'stdin'), 'utf8'),
    env: () => fs.readFileSync(path.join(dir, 'env'), 'utf8'),
  };
}

test('Copilot is found by what its --version says, held to read-only, and its last message is the answer', async () => {
  const copilot = fakeCopilot([
    { type: 'session.start', data: { copilotVersion: '1.0.98' } },
    { type: 'tool.execution_start', data: { toolName: 'view', arguments: { path: 'README.md' } } },
    // A message that asks for a tool is the agent saying what it will do, not its answer.
    { type: 'assistant.message', data: { content: 'Let me look.', toolRequests: [{ name: 'view' }] } },
    { type: 'assistant.message_delta', data: { deltaContent: 'All ' } },
    { type: 'assistant.message_delta', data: { deltaContent: 'good.' } },
    { type: 'assistant.message', data: { content: '\nAll good.', toolRequests: [] } },
    { type: 'result', exitCode: 0 },
  ]);
  const before = process.env.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS;
  process.env.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS = 'true';
  try {
    const h = harness({ paths: { copilot: copilot.program } });
    const { code, output } = await h.run({ agent: 'copilot', model: 'auto', prompt: 'Review ${clipboard}', access: 'read' });
    assert.equal(code, 0);
    assert.deepEqual(h.shown.clipboard, ['All good.']);
    assert.match(output, /› view README\.md/);
    const args = copilot.args();
    // The prompt goes in on stdin, context and all — never as an argument.
    assert.equal(copilot.stdin(), 'Review ');
    assert.ok(!args.includes('-p'));
    assert.ok(args.includes('--available-tools=view,glob,grep,rg'));
    assert.ok(args.includes('--deny-tool=write, shell, url, memory'));
    assert.ok(args.includes('--no-auto-update'));
    assert.ok(!args.includes('--allow-all'));
    // The repository's hooks are not let in through the environment, and the
    // version found is the version that runs.
    assert.doesNotMatch(copilot.env(), /GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS/);
    assert.match(copilot.env(), /^COPILOT_AUTO_UPDATE=false$/m);
  } finally {
    if (before === undefined) delete process.env.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS;
    else process.env.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS = before;
  }
});

test('Copilot saying its model is not available is a model problem, not a plain failure', async () => {
  const copilot = fakeCopilot(
    [{ type: 'session.error', data: { errorType: 'model_not_supported', message: 'Model "gpt-old" is not available.' } }],
    { exit: 1 },
  );
  const h = harness({ paths: { copilot: copilot.program } });
  const { code, problems } = await h.run({ agent: 'copilot', model: 'gpt-old', prompt: 'x', access: 'edit' });
  assert.equal(code, 1);
  assert.equal(problems[0].problem, 'model');
  assert.deepEqual(h.shown.errors, []);
  assert.ok(copilot.args().includes('--allow-tool=write'));
  assert.ok(copilot.args().includes('--available-tools=view,glob,grep,rg,create,edit,apply_patch,str_replace_editor'));
});

test('a program that only shares Copilot\'s name is not taken for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-copilot-'));
  const program = path.join(dir, 'copilot');
  fs.writeFileSync(program, '#!/bin/sh\necho "copilot version: v1.34.0 (AWS)"\n');
  fs.chmodSync(program, 0o755);
  const h = harness({ paths: { copilot: program } });
  // Only the configured path is looked at first; whatever else the machine has
  // must not be a real Copilot either for this to hold, so it is checked on
  // the configured candidate alone.
  const found = await h.ai.findAgent('copilot');
  assert.ok(!found || found.path !== program);
});

/** A local OpenAI-compatible server: `/models` and a streamed `/chat/completions`. */
function fakeApi(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seen.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : undefined });
        handler(request, response, seen.at(-1));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

const sse = (response, chunks) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
};

test('an API task streams its answer from the provider, with the key and the context sent', async () => {
  const api = await fakeApi((request, response) => sse(response, ['Hel', 'lo']));
  try {
    const h = harness({ providers: { Local: { baseUrl: api.url } }, keys: { Local: 'sk-test' }, clipboard: 'CTX' });
    const { code, output } = await h.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'Say ${clipboard}' });
    assert.equal(code, 0);
    assert.deepEqual(h.shown.clipboard, ['Hello']);
    assert.match(output, /Hello/);
    const [call] = api.seen;
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer sk-test');
    assert.equal(call.body.model, 'm1');
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'Say CTX' }]);
  } finally {
    api.server.close();
  }
});

test('an API that turns the key away, or does not know the model, offers the fix', async () => {
  const api = await fakeApi((request, response) => {
    const status = request.headers.authorization ? 404 : 401;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: status === 404 ? 'The model `m9` does not exist' : 'Invalid API key' } }));
  });
  try {
    const noKey = harness({ providers: { Local: { baseUrl: api.url } } });
    const refused = await noKey.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'x' });
    assert.equal(refused.problems[0].problem, 'provider');
    assert.match(refused.problems[0].detail, /401: Invalid API key/);

    const keyed = harness({ providers: { Local: { baseUrl: api.url } }, keys: { Local: 'k' } });
    const unknown = await keyed.run({ agent: 'api', provider: 'Local', model: 'm9', prompt: 'x' });
    assert.equal(unknown.problems[0].problem, 'model');

    const elsewhere = harness();
    const missing = await elsewhere.run({ agent: 'api', provider: 'Nowhere', model: 'm1', prompt: 'x' });
    assert.equal(missing.code, 127);
    assert.equal(missing.problems[0].problem, 'provider');
  } finally {
    api.server.close();
  }
});

test('an API task stopped mid-answer stops, and delivers nothing', async () => {
  const api = await fakeApi((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    // …and never finishes.
  });
  try {
    const h = harness({ providers: { Local: { baseUrl: api.url } } });
    const { code } = await h.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'x' }, { stopAfter: 300 });
    assert.equal(code, 130);
    assert.deepEqual(h.shown.clipboard, []);
  } finally {
    api.server.closeAllConnections?.();
    api.server.close();
  }
});

test('the models a provider lists are its /models', async () => {
  const api = await fakeApi((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b', owned_by: 'library' }, { id: 'llama3.2' }] }));
  });
  try {
    const h = harness();
    const models = await h.ai.apiModels({ name: 'Local', baseUrl: api.url });
    assert.deepEqual([...models.map((model) => model.name)], ['llama3.2', 'qwen2.5-coder:7b']);
  } finally {
    api.server.close();
  }
});

test('a key saved for another address is not sent, and the task says why', async () => {
  const api = await fakeApi((request, response) => sse(response, ['x']));
  try {
    // The address in settings was changed — by a dev container, say — after the key was saved.
    const h = harness({ providers: { Local: { baseUrl: api.url } }, keys: { Local: { key: 'sk', baseUrl: 'https://api.openai.com/v1' } } });
    const { code, problems } = await h.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'x' });
    assert.equal(code, 1);
    assert.equal(problems[0].problem, 'provider');
    assert.match(problems[0].detail, /not the one its key was saved for/);
    assert.equal(api.seen.length, 0);
  } finally {
    api.server.close();
  }
});

test('an error a provider sends with a 200 fails the task — in the stream, as JSON, or as a web page', async () => {
  const bodies = [
    (response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial' } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ error: { message: 'upstream overloaded' } })}\n\n`);
    },
    (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
    },
    (response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>Welcome to Open WebUI</html>');
    },
  ];
  for (const [index, body] of bodies.entries()) {
    const api = await fakeApi((request, response) => body(response));
    try {
      const h = harness({ providers: { Local: { baseUrl: api.url } } });
      const { code } = await h.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'x' });
      assert.equal(code, 1, String(index));
      assert.deepEqual(h.shown.clipboard, [], String(index));
    } finally {
      api.server.close();
    }
  }
});

test('a redirect is not followed with the prompt', async () => {
  const elsewhere = await fakeApi((request, response) => sse(response, ['leaked']));
  const api = await fakeApi((request, response) => {
    response.writeHead(307, { Location: `${elsewhere.url}/chat/completions` });
    response.end();
  });
  try {
    const h = harness({ providers: { Local: { baseUrl: api.url } } });
    const { code } = await h.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'secret ${clipboard}' });
    assert.equal(code, 1);
    assert.equal(elsewhere.seen.length, 0);
  } finally {
    api.server.close();
    elsewhere.server.close();
  }
});

test('escape sequences in a model\'s answer do not reach the terminal', async () => {
  const api = await fakeApi((request, response) => sse(response, ['ok\x1b[2J\x1b]52;c;ZXZpbA==\x07 done']));
  try {
    const h = harness({ providers: { Local: { baseUrl: api.url } } });
    let raw = '';
    const { code } = await h.run({ agent: 'api', provider: 'Local', model: 'm1', prompt: 'x' }).then((result) => (raw = result.output, result));
    assert.equal(code, 0);
    assert.doesNotMatch(raw, /\]52;|\[2J/);
  } finally {
    api.server.close();
  }
});

test('a command task\'s failure is its own, never a model problem of ours', async () => {
  const h = harness();
  const { problems } = await h.run({ agent: 'command', command: 'echo "Error: model gpt-x not found" >&2; exit 2', prompt: 'x' });
  assert.deepEqual(problems, []);
  assert.match(h.shown.errors[0], /model gpt-x not found/);
});

test('Copilot held to a limited level does not run in a folder Copilot trusts — read off its own commented config', async () => {
  const copilot = fakeCopilot([{ type: 'assistant.message', data: { content: 'ran' } }]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const before = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const h = harness({ paths: { copilot: copilot.program } });
    // The header Copilot itself writes, which plain JSON cannot read.
    fs.writeFileSync(
      path.join(home, 'config.json'),
      `// User settings belong in settings.json.\n// This file is managed automatically.\n{ "trustedFolders": [${JSON.stringify(h.scratch)}], }\n`,
    );
    const limited = await h.run({ agent: 'copilot', prompt: 'x', access: 'read' });
    assert.equal(limited.code, 1);
    assert.match(h.shown.errors[0], /Copilot trusts this folder/);
    assert.throws(() => copilot.args(), /ENOENT/);
    // Full access runs: it was never promising to keep the hooks out.
    const full = await h.run({ agent: 'copilot', prompt: 'x', access: 'full' });
    assert.equal(full.code, 0);
  } finally {
    if (before === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = before;
  }
});
