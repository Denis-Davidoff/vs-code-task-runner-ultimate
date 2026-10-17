import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_LABEL, ACCESS_LABEL, AiAccess, AiAgent, AiTask } from './aiTask';

// --- finding the agents ------------------------------------------------------

/** An agent found on this machine: where its program is, and the version it reports. */
export interface AgentInstall {
  agent: AiAgent;
  path: string;
  version: string;
}

/**
 * The PATH a login shell starts with. VS Code started from the Dock or a
 * desktop launcher hands its extensions the bare system PATH, without the
 * `~/.local/bin` or the Homebrew and nvm directories the user's profile adds —
 * which is where these agents install themselves. Asked once per window, and
 * not at all on Windows, where the PATH an extension gets is the user's own.
 */
let loginPath: Promise<string | undefined> | undefined;

function shellPath(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return Promise.resolve(undefined);
  }
  loginPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh';
    // A marker either side, because a profile is free to print whatever it likes
    // on the way in, and only what is between them is the PATH.
    cp.execFile(
      shell,
      ['-lc', 'printf "__PATH__%s__PATH__" "$PATH"'],
      { timeout: 5000, env: process.env },
      (_error, stdout) => resolve(/__PATH__(.*)__PATH__/s.exec(String(stdout ?? ''))?.[1]),
    );
  });
  return loginPath;
}

/** Every directory a program could be in: the login shell's PATH, this process's, and where the installers put them. */
async function searchDirectories(): Promise<string[]> {
  const home = os.homedir();
  const listed = [await shellPath(), process.env.PATH]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(path.delimiter));
  const known =
    process.platform === 'win32'
      ? [path.join(home, '.local', 'bin'), path.join(process.env.APPDATA ?? '', 'npm')]
      : [
          path.join(home, '.local', 'bin'),
          path.join(home, '.claude', 'local'),
          path.join(home, '.npm-global', 'bin'),
          path.join(home, '.bun', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ];
  return [...new Set([...listed, ...known].filter(Boolean))];
}

/** The environment an agent is started with: this one, with the login shell's PATH in front. */
async function agentEnvironment(): Promise<NodeJS.ProcessEnv> {
  const dirs = await searchDirectories();
  return { ...process.env, PATH: dirs.join(path.delimiter) };
}

const PROGRAM: Record<AiAgent, string> = { claude: 'claude', codex: 'codex' };

/**
 * What `--version` has to say for a program to be the agent it is named after.
 * The name alone is not enough: Cursor's agent and Grok's both install as
 * `agent`, and nothing stops some other `claude` from being first on PATH.
 */
const VERSION_SIGN: Record<AiAgent, RegExp> = { claude: /claude code/i, codex: /codex/i };

/**
 * The copies the agents' own VS Code extensions carry, for a machine where the
 * extension is installed and the command line is not: the Claude Code extension
 * ships its program under `resources/native-binary`, the Codex one under
 * `bin/<platform>`.
 */
function bundledCandidates(agent: AiAgent): string[] {
  const exe = process.platform === 'win32' ? `${PROGRAM[agent]}.exe` : PROGRAM[agent];
  if (agent === 'claude') {
    const root = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath;
    return root ? [path.join(root, 'resources', 'native-binary', exe)] : [];
  }
  const root = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
  if (!root) {
    return [];
  }
  try {
    return fs.readdirSync(path.join(root, 'bin')).map((platform) => path.join(root, 'bin', platform, exe));
  } catch {
    return [];
  }
}

function versionOf(program: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const [file, args] = spawnable(program, ['--version']);
    cp.execFile(
      file,
      args,
      { timeout: 10_000, shell: needsShell(program), windowsHide: true, env: shellSafeEnvironment(process.env, program) },
      (error, stdout, stderr) => resolve(error ? undefined : `${stdout}${stderr}`.trim()),
    );
  });
}

/**
 * A `.cmd` or `.bat` — what npm installs on Windows — cannot be started without
 * a shell there. Nothing the user typed goes on such a command line: the
 * arguments are flags of ours and a model name `validModel` has passed, and the
 * prompt goes in on stdin.
 */
function needsShell(program: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(program);
}

/**
 * The environment for a program, with cmd.exe told not to look in the current
 * directory for the programs it runs. npm's `.cmd` wrapper starts `node`, and
 * cmd.exe looks for it in the current directory before PATH — which is the
 * workspace folder, so a `node.bat` committed to the repository would run in
 * place of the agent, whatever access the task was approved with.
 */
function shellSafeEnvironment(env: NodeJS.ProcessEnv, program: string): NodeJS.ProcessEnv {
  return needsShell(program) ? { ...env, NoDefaultCurrentDirectoryInExePath: '1' } : env;
}

/**
 * A program and its arguments as `spawn` should be handed them. With a shell in
 * between, Node joins them with spaces and quotes nothing, so a path with a
 * space in it — any profile under `C:\Users\John Doe` — would be split in two.
 * Each is quoted; a Windows path cannot hold the `"` that would end it early.
 */
function spawnable(program: string, args: string[]): [string, string[]] {
  if (!needsShell(program)) {
    return [program, args];
  }
  const quote = (value: string) => (/[\s&|<>^()]/.test(value) ? `"${value}"` : value);
  return [quote(program), args.map(quote)];
}

/** The agents found so far, by name; a lookup that found nothing is not kept, so installing one is noticed. */
const found = new Map<AiAgent, AgentInstall>();

/**
 * Where an agent is on this machine, or `undefined` when it is nowhere this
 * looks: the path in `aiAgentPaths`, then every directory on PATH and where the
 * installers put it, then the copy its VS Code extension carries. The first
 * program whose `--version` names the agent wins.
 */
export async function findAgent(agent: AiAgent): Promise<AgentInstall | undefined> {
  const setting = vscode.workspace
    .getConfiguration('taskRunnerUltimate')
    .get<Record<string, unknown>>('aiAgentPaths', {})?.[agent];
  const configured = typeof setting === 'string' && setting.trim() ? setting.trim() : undefined;
  const cached = found.get(agent);
  if (cached && (configured === undefined || configured === cached.path)) {
    return cached;
  }
  const names =
    process.platform === 'win32'
      ? [`${PROGRAM[agent]}.exe`, `${PROGRAM[agent]}.cmd`]
      : [PROGRAM[agent]];
  const candidates = [
    ...(configured ? [configured] : []),
    ...(await searchDirectories()).flatMap((dir) => names.map((name) => path.join(dir, name))),
    ...bundledCandidates(agent),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (!isExecutable(candidate)) {
      continue;
    }
    const version = await versionOf(candidate);
    if (version && VERSION_SIGN[agent].test(version)) {
      const install = { agent, path: candidate, version: version.split('\n')[0] };
      found.set(agent, install);
      return install;
    }
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A model an agent offers, as the model picker lists it. */
export interface AgentModel {
  name: string;
  description?: string;
}

/**
 * The models an agent can be asked for by name. Claude Code takes aliases that
 * follow the newest model of each family, so those are the list. Codex keeps
 * the models the account can use in a cache beside its config, refreshed as it
 * runs; the ones it marks to be listed are the ones its own picker shows, in
 * its order. Neither list is the whole story — any name can still be typed.
 */
export async function agentModels(agent: AiAgent): Promise<AgentModel[]> {
  if (agent === 'claude') {
    return [
      { name: 'opus', description: 'the most capable' },
      { name: 'sonnet', description: 'fast and capable' },
      { name: 'haiku', description: 'the fastest' },
    ];
  }
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const cache = JSON.parse(await fs.promises.readFile(path.join(home, 'models_cache.json'), 'utf8'));
    const models: unknown[] = Array.isArray(cache?.models) ? cache.models : [];
    return models
      .filter(
        (model): model is { slug: string; description?: unknown; priority?: unknown } =>
          !!model &&
          typeof (model as { slug?: unknown }).slug === 'string' &&
          (model as { visibility?: unknown }).visibility === 'list',
      )
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      .map((model) => ({
        name: model.slug,
        description: typeof model.description === 'string' ? model.description : undefined,
      }));
  } catch {
    return [];
  }
}

/** Forgets what was found, for when the paths setting changes. */
export function forgetAgents(): void {
  found.clear();
}

// --- the command line --------------------------------------------------------

/**
 * What each level of access becomes for Claude Code. `dontAsk` refuses every
 * tool that is not listed — there is nobody to ask in a headless run — so the
 * list is the whole of what the agent may do, together with the commands Claude
 * Code itself counts as read-only. The tools go as one `=` argument because the
 * option takes a list, and would otherwise swallow whatever followed it.
 *
 * Each rule is scoped to the folder the agent runs in, `./**`. Unscoped, `Read`
 * reads `~/.ssh` as readily as the project, and `Write` writes a shell profile
 * or a LaunchAgent — which is running code, whatever the level says.
 *
 * The project's own Claude Code settings are left out of the two limited
 * levels. A `.claude/settings.json` that allows `Bash`, or runs a hook, is part
 * of the repository — the very thing a pull rewrites — and would otherwise widen
 * a task approved as read-only into whatever the repository says. The user's
 * own settings still apply.
 */
const CLAUDE_READ = ['Read', 'Grep', 'Glob'];
const CLAUDE_EDIT = [...CLAUDE_READ, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const inProject = (tools: string[]) => `--allowedTools=${tools.map((tool) => `${tool}(./**)`).join(',')}`;

const CLAUDE_ACCESS: Record<AiAccess, string[]> = {
  read: ['--permission-mode', 'dontAsk', inProject(CLAUDE_READ), '--setting-sources', 'user'],
  edit: ['--permission-mode', 'dontAsk', inProject(CLAUDE_EDIT), '--setting-sources', 'user'],
  full: ['--dangerously-skip-permissions'],
};

/**
 * And for Codex, whose sandbox is the boundary: read-only, the workspace
 * writable, or none at all. The limited levels leave out the execpolicy `.rules`
 * files for the same reason Claude Code's leave out the project's settings: a
 * repository's own rules are not something its pull gets to widen a task with.
 */
const CODEX_ACCESS: Record<AiAccess, string[]> = {
  read: ['--sandbox', 'read-only', '--ignore-rules'],
  edit: ['--sandbox', 'workspace-write', '--ignore-rules'],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
};

/**
 * The arguments an agent is started with. The prompt is not among them: it goes
 * in on stdin, where its length is not bounded by the OS and a prompt that
 * starts with `-` is not read as a flag.
 *
 * Claude Code reports as a stream of JSON events, which is what lets the
 * terminal show what it is doing while it does it and still hand over the final
 * answer whole. Codex prints its own progress, and writes the final answer to
 * `answerFile`.
 */
export function agentArgs(task: AiTask, answerFile: string): string[] {
  const model = task.model ? ['--model', task.model] : [];
  if (task.agent === 'claude') {
    return ['-p', '--output-format', 'stream-json', '--verbose', ...model, ...CLAUDE_ACCESS[task.access]];
  }
  return [
    'exec',
    // An AI task is somebody's own choice to run the agent in this folder, so
    // the folder not being a git repository is not a reason to refuse.
    '--skip-git-repo-check',
    '--color',
    'always',
    ...model,
    ...CODEX_ACCESS[task.access],
    '--output-last-message',
    answerFile,
    '-',
  ];
}

// --- running -----------------------------------------------------------------

/** Where the reports are written; set once the extension knows its storage. */
let reportsRoot: vscode.Uri | undefined;

export function setReportsRoot(root: vscode.Uri): void {
  reportsRoot = root;
}

/**
 * A failure that is about the task's choice of agent rather than about its
 * work: the agent is not installed here, or the model it names is not one this
 * agent can use here. Both are what a project moved to another machine runs
 * into, and both are answered by changing the agent or the model — which is why
 * they are told apart from every other failure.
 */
export type AgentProblem = 'missing' | 'model';

export interface AiRunRequest {
  /** The row's key: what a stop waits on, through `agentsStopped`. */
  key: string;
  name: string;
  task: AiTask;
  cwd: string;
  /**
   * Told about an `AgentProblem` in place of the plain failure notification, so
   * the message can offer to fix it. Called once the task has ended.
   */
  onAgentProblem?: (problem: AgentProblem, detail: string) => void;
}

/**
 * What an agent says when the model it was asked for is not there for it. Claude
 * Code sends a structured `model_not_found` on its stream as well, which is read
 * first; this is for its stderr and for Codex, which says it in prose — "The
 * 'x' model is not supported when using Codex with a ChatGPT account", or a
 * `model_not_found` / "does not exist" from the API behind it.
 */
const MODEL_PROBLEM =
  /model_not_found|unrecognized_model|\bmodel\b[^\n]{0,120}?\b(?:not supported|not found|does not exist|is not available|unknown|unsupported|no access)/i;

export function isModelProblem(text: string): boolean {
  return MODEL_PROBLEM.test(text);
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

/** Text for a terminal: its line breaks as the terminal needs them. */
function terminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * Text that is somebody else's — a file path an agent chose, the input of a tool
 * call — on its way into a one-line summary: its control characters dropped, so
 * it cannot move the cursor or recolour what comes after it.
 */
function plain(text: string): string {
  // Colour codes go whole first — Codex colours its errors — or the control
  // characters would go and leave their `[31m` behind in a notification.
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim();
}

/**
 * Text going into a notification. The workbench reads `[label](command:…)` in a
 * notification as a link and runs the command when it is clicked, and the text
 * here is an agent's — steered by whatever it read in the project — or a task
 * name out of a file anybody can write. Breaking the `](` is enough to keep it
 * text: that pair is what the link pattern needs.
 */
export function notificationText(text: string): string {
  return text.replace(/\]\s*\(/g, '] (');
}

/**
 * Every run that is open — looking for its agent, or with the agent up. An
 * agent is started in a process group of its own so that a stop reaches what it
 * started, and the same thing keeps it from dying with the window — so the
 * window going away stops them itself, including one about to start.
 */
const live = new Set<AiRun>();

/**
 * Resolves once every run of a row has let go of its agent, or after `timeout`.
 * The task system counts an AI task as ended the moment its terminal goes, which
 * is before the agent has heard SIGTERM; a restart that did not wait for this
 * would have two agents editing the same files.
 */
export async function agentsStopped(key: string, timeout = 5000): Promise<void> {
  const runs = [...live].filter((run) => run.key === key);
  if (runs.length === 0) {
    return;
  }
  await Promise.race([Promise.all(runs.map((run) => run.gone)), new Promise((resolve) => setTimeout(resolve, timeout))]);
}

/** Stops every agent still running, for when the extension is deactivated. */
export function stopAllRuns(): void {
  for (const run of [...live]) {
    run.close();
  }
}

/**
 * One run of an AI task, as the terminal of a task. The task system owns the
 * terminal and its lifetime — the running count, Stop, Restart all see an
 * ordinary task — and this owns the agent's process inside it: started on
 * `open`, killed on `close`, and its final answer handed on when it ends.
 */
export class AiRun implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.written.event;
  readonly onDidClose = this.closed.event;

  private child: cp.ChildProcess | undefined;
  /** Set once the run has been told to stop, so its ending is not reported as a failure. */
  private stopping = false;
  private finished = false;
  private started = 0;
  /** Claude Code's final event, once it has arrived. */
  private result: { text: string; error: boolean } | undefined;
  /** The last line the agent wrote to stderr, which is usually the reason it failed. */
  private lastError = '';
  /** Set once the agent has said the model is not one it can use. See `AgentProblem`. */
  private modelProblem = false;
  private pending = '';
  private answerFile = '';
  /** Resolves once there is no agent process left: it exited, or was never started. */
  readonly gone: Promise<void>;
  private settle: () => void = () => undefined;

  constructor(private readonly request: AiRunRequest) {
    this.gone = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  get key(): string {
    return this.request.key;
  }

  open(): void {
    live.add(this);
    void this.start();
  }

  /** The run has no process any more. */
  private released(): void {
    live.delete(this);
    this.settle();
  }

  close(): void {
    this.stop();
  }

  handleInput(data: string): void {
    // Ctrl+C, the way it stops anything else in a terminal.
    if (data.includes('\x03')) {
      this.write(`\r\n${DIM}Stopping…${RESET}\r\n`);
      this.stop();
    }
  }

  private write(text: string): void {
    this.written.fire(text);
  }

  private async start(): Promise<void> {
    const { task, cwd } = this.request;
    const install = await findAgent(task.agent);
    if (this.stopping) {
      this.end(130);
      return;
    }
    if (!install) {
      this.write(
        `${RED}${AGENT_LABEL[task.agent]} was not found on this machine.${RESET}\r\n` +
          `Install its command line, or set its path in the taskRunnerUltimate.aiAgentPaths setting.\r\n`,
      );
      this.end(127, `${AGENT_LABEL[task.agent]} was not found on this machine.`, 'missing');
      return;
    }
    // Resolved before the check below, which is then the last thing between the
    // lookups and the spawn: a stop that came while either was in flight is seen.
    const env = await agentEnvironment();
    if (this.stopping) {
      this.end(130);
      return;
    }
    const model = task.model ? ` (${task.model})` : '';
    this.write(
      `${BOLD}${AGENT_LABEL[task.agent]}${model}${RESET} ${DIM}· ${ACCESS_LABEL[task.access]} · ${install.version}${RESET}\r\n` +
        `${DIM}${plain(cwd)}${RESET}\r\n\r\n`,
    );

    this.answerFile = path.join(os.tmpdir(), `task-runner-ai-${process.pid}-${Date.now()}.md`);
    this.started = Date.now();
    let child: cp.ChildProcess;
    try {
      const [file, args] = spawnable(install.path, agentArgs(task, this.answerFile));
      child = cp.spawn(file, args, {
        cwd,
        env: shellSafeEnvironment(env, install.path),
        shell: needsShell(install.path),
        // Its own process group, so a stop reaches the commands the agent
        // started as well as the agent: killing only the parent would leave a
        // build it was running carrying on with nothing to report to.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      this.end(1, error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    child.on('error', (error) => {
      this.lastError = error.message;
      // A program that could not be started at all may say so here and never
      // close, and nothing else would end the task.
      if (child.pid === undefined) {
        this.released();
        this.end(127, error.message);
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (task.agent === 'claude') {
        this.claudeOutput(chunk);
      } else {
        this.noteModelProblem(chunk);
        this.write(terminalText(chunk));
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      this.noteModelProblem(chunk);
      const lines = chunk.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length > 0) {
        this.lastError = lines[lines.length - 1];
      }
      this.write(task.agent === 'claude' ? `${RED}${terminalText(chunk)}${RESET}` : terminalText(chunk));
    });
    child.on('close', (code) => void this.exited(code ?? 1));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(task.prompt);
  }

  private noteModelProblem(text: string): void {
    if (!this.modelProblem && isModelProblem(text)) {
      this.modelProblem = true;
    }
  }

  /** Claude Code's events, one JSON object a line, split however the pipe chose to deliver them. */
  private claudeOutput(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        this.claudeEvent(line);
      }
    }
  }

  private claudeEvent(line: string): void {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      this.write(terminalText(`${line}\n`));
      return;
    }
    if (event.type === 'assistant') {
      if (event.error === 'model_not_found') {
        this.modelProblem = true;
      }
      for (const part of event.message?.content ?? []) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          this.write(terminalText(`${part.text}\n\n`));
        } else if (part?.type === 'tool_use') {
          this.write(`${CYAN}› ${plain(String(part.name ?? 'tool'))}${RESET} ${DIM}${toolSummary(part.input)}${RESET}\r\n`);
        }
      }
    } else if (event.type === 'user') {
      for (const part of event.message?.content ?? []) {
        if (part?.type === 'tool_result' && part.is_error) {
          const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
          this.write(`${YELLOW}  ✗ ${plain(text).slice(0, 200)}${RESET}\r\n`);
        }
      }
    } else if (event.type === 'result') {
      this.result = {
        text: typeof event.result === 'string' ? event.result : '',
        error: !!event.is_error || event.subtype !== 'success',
      };
    }
  }

  private async exited(code: number): Promise<void> {
    this.released();
    if (this.stopping) {
      this.write(`\r\n${DIM}Stopped.${RESET}\r\n`);
      this.end(130);
      return;
    }
    const { task } = this.request;
    let answer: string | undefined;
    if (task.agent === 'claude') {
      // The last event, when the stream ended without the line break after it.
      if (this.pending.trim()) {
        this.claudeEvent(this.pending);
        this.pending = '';
      }
      answer = code === 0 && this.result && !this.result.error ? this.result.text : undefined;
      if (!answer && this.result?.text) {
        this.lastError = this.result.text;
      }
    } else if (code === 0) {
      answer = await fs.promises.readFile(this.answerFile, 'utf8').catch(() => undefined);
    }
    await fs.promises.rm(this.answerFile, { force: true }).catch(() => undefined);

    // Stopped while the answer was being collected: the user said Stop, and a
    // report opening a moment later would be the run carrying on regardless.
    if (this.stopping) {
      this.end(130);
      return;
    }
    if (answer === undefined) {
      this.end(
        code === 0 ? 1 : code,
        this.lastError || `${AGENT_LABEL[task.agent]} exited with code ${code}.`,
        this.modelProblem ? 'model' : undefined,
      );
      return;
    }
    const seconds = Math.round((Date.now() - this.started) / 1000);
    this.write(`\r\n${DIM}Finished in ${seconds} s.${RESET}\r\n`);
    this.end(0);
    await deliver(this.request, answer.trim(), seconds);
  }

  /** Ends the terminal's task, and says why when it failed and somebody did not ask for it. */
  private end(code: number, failure?: string, problem?: AgentProblem): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (!this.child) {
      // Ended before an agent was started — not found, or stopped while it was
      // being looked for — so there is no process to wait for.
      this.released();
    }
    if (failure !== undefined) {
      this.write(`\r\n${RED}${terminalText(failure)}${RESET}\r\n`);
    }
    this.closed.fire(code);
    if (failure === undefined) {
      return;
    }
    // After the task has ended, so a run started from the offer that follows is
    // a new run of the row rather than one queued behind this.
    if (problem && this.request.onAgentProblem) {
      this.request.onAgentProblem(problem, plain(failure).slice(0, 300));
    } else {
      void vscode.window.showErrorMessage(
        notificationText(`"${this.request.name}" failed: ${plain(failure).slice(0, 300)}`),
      );
    }
  }

  private stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.pid === undefined) {
      if (!child) {
        // Not started yet — still looking for the agent. `start` sees the flag.
        return;
      }
      this.end(130);
      return;
    }
    const pid = child.pid;
    if (process.platform === 'win32') {
      // The whole tree, by force: the agent may be a `.cmd` under cmd.exe, and
      // killing that shell would leave the agent it started running on.
      cp.execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      return;
    }
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-pid, name);
      } catch {
        // The group is gone.
      }
    };
    signal('SIGTERM');
    // An agent mid-way through a tool call can take a while to hear it; one that
    // does not within a few seconds is not going to. Sent to the group whether
    // the agent itself has gone or not: a build it started may ignore SIGTERM
    // and outlive it, which is what the group was there to prevent.
    setTimeout(() => signal('SIGKILL'), 3000);
  }
}

/** The input of a tool call in a few words: the path, command or pattern it was for. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const data = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
    if (typeof data[key] === 'string') {
      return plain(data[key] as string).slice(0, 160);
    }
  }
  return '';
}

/**
 * The answer, where the task said it should go: a report opened beside the
 * editor, or the clipboard, or nowhere — and then the notification, which says
 * that it is done, or says the answer itself.
 */
async function deliver(request: AiRunRequest, answer: string, seconds: number): Promise<void> {
  const { task, name } = request;
  let report: vscode.Uri | undefined;
  if (task.result === 'report') {
    report = await writeReport(request, answer, seconds);
    if (report) {
      await vscode.commands.executeCommand('markdown.showPreview', report);
    }
  } else if (task.result === 'clipboard') {
    await vscode.env.clipboard.writeText(answer);
  }
  if (task.notify === 'none') {
    return;
  }
  const where = task.result === 'clipboard' ? ' The answer is on the clipboard.' : '';
  const open = 'Open Report';
  const copy = 'Copy Answer';
  const actions = [...(report ? [open] : []), ...(task.result !== 'clipboard' ? [copy] : [])];
  const message =
    task.notify === 'text'
      ? `${name}: ${oneLine(answer)}`
      : `"${name}" finished in ${seconds} s.${where}`;
  const picked = await vscode.window.showInformationMessage(notificationText(message), ...actions);
  if (picked === open && report) {
    await vscode.commands.executeCommand('markdown.showPreview', report);
  } else if (picked === copy) {
    await vscode.env.clipboard.writeText(answer);
  }
}

/** An answer in a notification: one line, short enough that the toast shows all of it. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}

/**
 * The answer as a Markdown file in the extension's own storage for this
 * workspace — out of the project, so a report is never something to commit or
 * ignore.
 */
async function writeReport(request: AiRunRequest, answer: string, seconds: number): Promise<vscode.Uri | undefined> {
  if (!reportsRoot) {
    return undefined;
  }
  const { task, name } = request;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*$/, '');
  const slug = name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
  const dir = vscode.Uri.joinPath(reportsRoot, 'ai-reports');
  const file = vscode.Uri.joinPath(dir, `${slug}-${stamp}.md`);
  const model = task.model ? ` (${task.model})` : '';
  const body = [
    `# ${name}`,
    '',
    `${AGENT_LABEL[task.agent]}${model} · ${ACCESS_LABEL[task.access]} · ${new Date().toLocaleString()} · ${seconds} s`,
    '',
    '---',
    '',
    answer,
    '',
  ].join('\n');
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, Buffer.from(body, 'utf8'));
  } catch (error) {
    void vscode.window.showErrorMessage(
      notificationText(`The report of "${name}" was not saved: ${error instanceof Error ? error.message : String(error)}`),
    );
    return undefined;
  }
  return file;
}
