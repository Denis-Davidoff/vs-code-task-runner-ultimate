import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { contextValues, sentLength, substitute, usedVariables } from './aiContext';
import { ACCESS_LABEL, accessText, AGENT_LABEL, AiAccess, AiTask, agentText, CliAgent, isCliAgent, validProvider } from './aiTask';

// --- finding the agents ------------------------------------------------------

/** An agent found on this machine: where its program is, and the version it reports. */
export interface AgentInstall {
  agent: CliAgent;
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

/**
 * Everything that differs from one agent to the next, in one place: what its
 * program is called, how it says which program it is, where its VS Code
 * extension keeps a copy, what models it offers, the arguments each level of
 * access becomes, and how to read what it writes.
 */
interface Adapter {
  /** The program's names, in the order they are looked for. */
  programs: string[];
  /**
   * What `--version` has to say for a program to be the agent it is named after.
   * The name alone is not enough: AWS's CLI also installs as `copilot`, and
   * nothing stops some other `claude` from being first on PATH.
   */
  versionSign: RegExp;
  /** The copies the agent's own VS Code extension carries, for a machine where the extension is installed and the command line is not. */
  bundled(): string[];
  models(): Promise<AgentModel[]>;
  /** The arguments. The prompt is not among them: it goes in on stdin. */
  args(task: AiTask, answerFile: string): string[];
  /** The environment it is started with, from the one every agent gets. */
  env?(env: NodeJS.ProcessEnv, task: AiTask): NodeJS.ProcessEnv;
  /** How it is asked its version, when that is not just `--version`. */
  versionArgs?: string[];
  /** How its standard output is read. See `OutputReader`. */
  output: 'claude' | 'copilot' | 'text';
  /** For `text`: the final answer is the file the agent writes, not its output. */
  answerFile?: boolean;
}

function extensionPath(id: string): string | undefined {
  return vscode.extensions.getExtension(id)?.extensionPath;
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

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
 * And for GitHub Copilot's CLI. Each limited level names the tools the model is
 * shown at all — a tool it is not shown is one nothing can approve, not a rule
 * in the user's config and not a hook in a trusted repository — and denies the
 * kinds of permission it must never get besides, since a deny rule wins over
 * any allow. Read-only is the three tools that read; Edit adds the three that
 * write, with Copilot's own path check holding writes to the folder it runs in,
 * and no shell at all: a command runs as the user, and can write anywhere.
 * Neither lets the built-in MCP servers in, or writes to the temp folder.
 */
const COPILOT_ACCESS: Record<AiAccess, string[]> = {
  // `rg` is what some models are given in `grep`'s place, and
  // `str_replace_editor` what they write with: listed so such a model is not
  // left without the tools its level allows.
  read: [
    '--available-tools=view,glob,grep,rg',
    '--deny-tool=write, shell, url, memory',
    '--disable-builtin-mcps',
    '--disallow-temp-dir',
  ],
  edit: [
    '--available-tools=view,glob,grep,rg,create,edit,apply_patch,str_replace_editor',
    '--allow-tool=write',
    '--deny-tool=shell, url, memory',
    '--disable-builtin-mcps',
    '--disallow-temp-dir',
  ],
  full: ['--allow-all'],
};

/**
 * The environment variables that widen what Copilot does in a headless run —
 * load the repository's hooks, MCP servers or extensions, allow every tool, or
 * switch to autopilot. Each is the user's to set for their own sessions; none is
 * passed on to a task held to a limited level. At Full access Copilot runs with
 * the user's environment as it is, the way it would in their own terminal.
 */
const COPILOT_WIDENING = /^(GITHUB_COPILOT_PROMPT_MODE_|COPILOT_ALLOW_ALL$|COPILOT_PLAN_THEN_AUTOPILOT$)/;

const ADAPTERS: Record<CliAgent, Adapter> = {
  claude: {
    programs: ['claude'],
    versionSign: /claude code/i,
    bundled: () => {
      const root = extensionPath('anthropic.claude-code');
      return root ? [path.join(root, 'resources', 'native-binary', exe('claude'))] : [];
    },
    models: async () => [
      { name: 'opus', description: 'the most capable' },
      { name: 'sonnet', description: 'fast and capable' },
      { name: 'haiku', description: 'the fastest' },
    ],
    args: (task) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(task.model ? ['--model', task.model] : []),
      ...CLAUDE_ACCESS[task.access],
    ],
    output: 'claude',
  },
  codex: {
    programs: ['codex'],
    versionSign: /codex/i,
    bundled: () => {
      const root = extensionPath('openai.chatgpt');
      if (!root) {
        return [];
      }
      try {
        return fs.readdirSync(path.join(root, 'bin')).map((platform) => path.join(root, 'bin', platform, exe('codex')));
      } catch {
        return [];
      }
    },
    models: codexModels,
    args: (task, answerFile) => [
      'exec',
      // An AI task is somebody's own choice to run the agent in this folder, so
      // the folder not being a git repository is not a reason to refuse.
      '--skip-git-repo-check',
      '--color',
      'always',
      ...(task.model ? ['--model', task.model] : []),
      ...CODEX_ACCESS[task.access],
      '--output-last-message',
      answerFile,
      '-',
    ],
    output: 'text',
    answerFile: true,
  },
  copilot: {
    programs: ['copilot'],
    versionSign: /github copilot cli/i,
    bundled: () => [],
    models: async () => [{ name: 'auto', description: 'let Copilot choose' }],
    // No `-p`: Copilot reads a piped prompt in its place, and ignores stdin once
    // it is given one as an argument.
    args: (task) => [
      '--output-format',
      'json',
      '--no-ask-user',
      // The version that was found is the version that runs, rather than a newer
      // one the CLI fetched in the background since.
      '--no-auto-update',
      ...(task.model ? ['--model', task.model] : []),
      ...COPILOT_ACCESS[task.access],
    ],
    env: (env, task) => ({
      ...(task.access === 'full'
        ? env
        : Object.fromEntries(Object.entries(env).filter(([name]) => !COPILOT_WIDENING.test(name)))),
      COPILOT_AUTO_UPDATE: 'false',
    }),
    // Asked the way it is run: without the flag, `--version` reports the newest
    // build Copilot has fetched into its cache, which `--no-auto-update` does
    // not run.
    versionArgs: ['--no-auto-update', '--version'],
    output: 'copilot',
  },
};

/**
 * JSON with the comments and trailing commas a hand-kept — or, as Copilot's
 * own, machine-kept — config file may hold, read as JSON. Strings are walked
 * over whole, so a `//` inside a path is not a comment.
 */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          i++;
        }
      }
      out += text.slice(start, i + 1);
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) {
        break;
      }
      i++;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Whether Copilot treats a folder as trusted: the user told it so, and it keeps
 * the folder in `trustedFolders` — in `config.json` beside its settings, or in
 * `settings.json`, under `COPILOT_HOME` when that is set. In a trusted folder
 * the repository's hooks run even in a headless run, and a hook can run any
 * command it likes as the session starts, whatever tools the model is shown.
 * Nothing on Copilot's command line turns that off — so a task held to a
 * limited level does not run there at all. See `AiRun.start`.
 */
export function copilotTrusts(folder: string): boolean {
  const home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const inside = (entry: string) =>
    folder === entry || folder.startsWith(entry.endsWith(path.sep) ? entry : `${entry}${path.sep}`);
  for (const file of ['config.json', 'settings.json']) {
    try {
      const config = parseJsonc(fs.readFileSync(path.join(home, file), 'utf8')) as { trustedFolders?: unknown };
      const trusted: unknown[] = Array.isArray(config?.trustedFolders) ? config.trustedFolders : [];
      if (trusted.some((entry) => typeof entry === 'string' && inside(entry))) {
        return true;
      }
    } catch {
      // Not there, or not readable as JSON: says nothing either way.
    }
  }
  return false;
}

function versionOf(program: string, versionArgs = ['--version']): Promise<string | undefined> {
  return new Promise((resolve) => {
    const [file, args] = spawnable(program, versionArgs);
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
const found = new Map<CliAgent, AgentInstall>();

/**
 * Where an agent is on this machine, or `undefined` when it is nowhere this
 * looks: the path in `aiAgentPaths`, then every directory on PATH and where the
 * installers put it, then the copy its VS Code extension carries. The first
 * program whose `--version` names the agent wins.
 */
export async function findAgent(agent: CliAgent): Promise<AgentInstall | undefined> {
  const adapter = ADAPTERS[agent];
  const setting = vscode.workspace
    .getConfiguration('taskRunnerUltimate')
    .get<Record<string, unknown>>('aiAgentPaths', {})?.[agent];
  const configured = typeof setting === 'string' && setting.trim() ? setting.trim() : undefined;
  const cached = found.get(agent);
  if (cached && (configured === undefined || configured === cached.path)) {
    return cached;
  }
  const names = adapter.programs.flatMap((program) =>
    process.platform === 'win32' ? [`${program}.exe`, `${program}.cmd`] : [program],
  );
  const candidates = [
    ...(configured ? [configured] : []),
    ...(await searchDirectories()).flatMap((dir) => names.map((name) => path.join(dir, name))),
    ...adapter.bundled(),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (!isExecutable(candidate)) {
      continue;
    }
    const version = await versionOf(candidate, adapter.versionArgs);
    if (version && adapter.versionSign.test(version)) {
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
 * its order. Copilot says which models an account has only from inside a
 * session, so its list starts at `auto`. None of these lists is the
 * whole story — any name can still be typed.
 */
export async function agentModels(agent: CliAgent): Promise<AgentModel[]> {
  return ADAPTERS[agent].models();
}

async function codexModels(): Promise<AgentModel[]> {
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
 * The arguments an agent is started with. The prompt is not among them: it goes
 * in on stdin, where its length is not bounded by the OS and a prompt that
 * starts with `-` is not read as a flag.
 */
export function agentArgs(task: AiTask, answerFile: string): string[] {
  if (!isCliAgent(task.agent)) {
    return [];
  }
  return ADAPTERS[task.agent].args(task, answerFile);
}

// --- running -----------------------------------------------------------------

/** Where the reports are written; set once the extension knows its storage. */
let reportsRoot: vscode.Uri | undefined;

export function setReportsRoot(root: vscode.Uri): void {
  reportsRoot = root;
}

/**
 * A failure that is about the task's choice of agent rather than about its
 * work: the agent is not installed here, the model it names is not one this
 * agent can use here, or the API provider it names is not set up here or turns
 * its key away. All three are what a project moved to another machine runs
 * into, and all are answered by changing the agent, the model or the provider —
 * which is why they are told apart from every other failure.
 */
export type AgentProblem = 'missing' | 'model' | 'provider';

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
 * A model's text on its way into the terminal: its line breaks and tabs kept,
 * every escape sequence and other control character dropped. What a model
 * writes can be steered by what it read, and a terminal obeys what it is sent —
 * a clear screen, a hyperlink that says one thing and opens another, a write
 * to the clipboard.
 */
function terminalSafe(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
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

/** Who is told how each run ended, by row key — see `onAiRunEnd`. */
const endListeners = new Set<(key: string, code: number) => void>();

/**
 * Hears how every AI task run ends: the row's key and the exit code its task
 * ended with. The task system reports a code only for a process it started, and
 * an AI task's process is ours, so a workflow waiting on one learns it here.
 * Told before the task itself ends, so the code is in by the time anything
 * listening for the end goes looking for it.
 */
export function onAiRunEnd(listener: (key: string, code: number) => void): { dispose(): void } {
  endListeners.add(listener);
  return { dispose: () => endListeners.delete(listener) };
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

/** Where an output reader puts what it read: the terminal, said the way each kind of event is said. */
interface Sink {
  text(text: string): void;
  tool(name: string, detail: string): void;
  refused(detail: string): void;
}

/**
 * How an agent's standard output is read: shown in the terminal as it comes,
 * and kept for what the run ends with — the final answer, or why there is none.
 */
interface OutputReader {
  feed(chunk: string): void;
  /** Called once the output has ended. */
  finish(): void;
  /** The final answer, when the agent gave one. */
  answer(): string | undefined;
  /** What the agent said went wrong, when it said so in its output rather than on stderr. */
  failure(): string | undefined;
  /** Whether the agent said the model is not one it can use. */
  modelProblem: boolean;
}

/** Output that is one JSON object a line, split however the pipe chose to deliver it. */
abstract class JsonLines implements OutputReader {
  private pending = '';
  modelProblem = false;

  constructor(protected readonly sink: Sink) {}

  feed(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      this.line(line);
    }
  }

  finish(): void {
    // The last event, when the stream ended without the line break after it.
    if (this.pending.trim()) {
      this.line(this.pending);
    }
    this.pending = '';
  }

  private line(line: string): void {
    if (!line.trim()) {
      return;
    }
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      this.sink.text(`${line}\n`);
      return;
    }
    if (event && typeof event === 'object') {
      this.event(event);
    }
  }

  protected abstract event(event: Record<string, any>): void;
  abstract answer(): string | undefined;
  abstract failure(): string | undefined;
}

/** Claude Code's `stream-json`: assistant messages, tool results, and a `result` that holds the answer. */
class ClaudeReader extends JsonLines {
  private result: { text: string; error: boolean } | undefined;

  protected event(event: Record<string, any>): void {
    if (event.type === 'assistant') {
      if (event.error === 'model_not_found') {
        this.modelProblem = true;
      }
      for (const part of event.message?.content ?? []) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          this.sink.text(`${part.text}\n\n`);
        } else if (part?.type === 'tool_use') {
          this.sink.tool(String(part.name ?? 'tool'), toolSummary(part.input));
        }
      }
    } else if (event.type === 'user') {
      for (const part of event.message?.content ?? []) {
        if (part?.type === 'tool_result' && part.is_error) {
          this.sink.refused(typeof part.content === 'string' ? part.content : JSON.stringify(part.content));
        }
      }
    } else if (event.type === 'result') {
      this.result = {
        text: typeof event.result === 'string' ? event.result : '',
        error: !!event.is_error || event.subtype !== 'success',
      };
    }
  }

  answer(): string | undefined {
    return this.result && !this.result.error ? this.result.text : undefined;
  }

  failure(): string | undefined {
    return this.result?.error && this.result.text ? this.result.text : undefined;
  }
}

/**
 * GitHub Copilot's `--output-format json`: one event a line, `{type, data}`.
 * The answer is the last whole assistant message of the main agent — one a
 * sub-agent wrote carries an `agentId`, and is its own business.
 */
class CopilotReader extends JsonLines {
  private last: string | undefined;
  private streamed = false;
  private error: string | undefined;

  protected event(event: Record<string, any>): void {
    const data = event.data ?? {};
    // A sub-agent's events are marked on the event itself — and on its data in
    // older builds.
    const sub = !!(event.agentId ?? data.agentId);
    switch (event.type) {
      case 'assistant.message_delta':
        if (typeof data.deltaContent === 'string' && !sub) {
          this.streamed = true;
          this.sink.text(data.deltaContent);
        }
        break;
      case 'assistant.message':
        // The answer is a message that asks for no more tools: one that does is
        // the agent saying what it is about to do.
        if (
          typeof data.content === 'string' &&
          data.content.trim() &&
          !sub &&
          !(Array.isArray(data.toolRequests) && data.toolRequests.length > 0)
        ) {
          this.last = data.content.replace(/^\n+/, '');
        }
        if (typeof data.content === 'string' && data.content.trim() && !sub) {
          // Said in pieces as it came, or all at once now when it was not.
          this.sink.text(this.streamed ? '\n\n' : `${data.content}\n\n`);
        }
        this.streamed = false;
        break;
      case 'tool.execution_start':
        this.sink.tool(String(data.toolName ?? 'tool'), toolSummary(data.arguments));
        break;
      case 'tool.execution_complete':
        if (data.success === false) {
          this.sink.refused(String(data.error?.message ?? data.error ?? 'failed'));
        }
        break;
      case 'permission.completed':
        if (typeof data.result?.kind === 'string' && data.result.kind.startsWith('denied')) {
          this.sink.refused(`not allowed: ${data.result.kind}`);
        }
        break;
      case 'session.error':
        this.error = String(data.message ?? data.errorType ?? 'error');
        if (isModelProblem(this.error) || /model/i.test(String(data.errorType ?? ''))) {
          this.modelProblem = true;
        }
        break;
    }
  }

  answer(): string | undefined {
    return this.error ? undefined : this.last;
  }

  failure(): string | undefined {
    return this.error;
  }
}

/** Plain text, shown as it comes — Codex's progress, or whatever a command of the user's own prints. */
class TextReader implements OutputReader {
  private text = '';
  modelProblem = false;

  constructor(private readonly sink: Sink) {}

  feed(chunk: string): void {
    this.text += chunk;
    if (isModelProblem(chunk)) {
      this.modelProblem = true;
    }
    this.sink.text(chunk);
  }

  finish(): void {}

  /** All of it, without its colour codes: the answer of a command that prints one. */
  answer(): string | undefined {
    return this.text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  failure(): string | undefined {
    return undefined;
  }
}

/**
 * One run of an AI task, as the terminal of a task. The task system owns the
 * terminal and its lifetime — the running count, Stop, Restart all see an
 * ordinary task — and this owns the agent inside it: its process, or its
 * request to an API, started on `open`, ended on `close`, and its final answer
 * handed on when it is done.
 */
export class AiRun implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.written.event;
  readonly onDidClose = this.closed.event;

  private child: cp.ChildProcess | undefined;
  /** The request to an API, for a task that runs one. */
  private request_: AbortController | undefined;
  /** Set once the run has been told to stop, so its ending is not reported as a failure. */
  private stopping = false;
  private finished = false;
  private started = 0;
  private reader: OutputReader | undefined;
  /** The last line the agent wrote to stderr, which is usually the reason it failed. */
  private lastError = '';
  /** Set once the agent has said the model is not one it can use. See `AgentProblem`. */
  private modelProblem = false;
  private answerFile = '';
  /** Resolves once there is no agent left: its process exited, its request ended, or neither was started. */
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

  /** The run has no process or request any more. */
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

  private readonly sink: Sink = {
    text: (text) => this.write(terminalText(terminalSafe(text))),
    tool: (name, detail) => this.write(`${CYAN}› ${plain(name)}${RESET} ${DIM}${detail}${RESET}\r\n`),
    refused: (detail) => this.write(`${YELLOW}  ✗ ${plain(detail).slice(0, 200)}${RESET}\r\n`),
  };

  /**
   * The prompt as it is sent: with the context it names read now and put in.
   * The terminal says which, and how much of each, so a report written from an
   * empty `${selection}` is not a mystery.
   */
  private async prompt(): Promise<string> {
    const { task, cwd } = this.request;
    const names = usedVariables(task.prompt);
    if (names.length === 0) {
      return task.prompt;
    }
    const values = await contextValues(names, cwd);
    const sizes = names.map(
      (name) => `\${${name}} ${formatSize(sentLength(values[name]))}${sentLength(values[name]) < (values[name]?.length ?? 0) ? ' (cut)' : ''}`,
    );
    this.write(`${DIM}Context: ${sizes.join(', ')}${RESET}\r\n`);
    return substitute(task.prompt, values);
  }

  private header(version?: string): void {
    const { task, cwd } = this.request;
    const who = task.agent === 'command' || task.agent === 'api' ? AGENT_LABEL[task.agent] : agentText(task);
    const detail = [task.agent === 'command' || task.agent === 'api' ? agentText(task) : undefined, accessText(task), version]
      .filter(Boolean)
      .join(' · ');
    this.write(`${BOLD}${plain(who)}${RESET} ${DIM}· ${plain(detail)}${RESET}\r\n${DIM}${plain(cwd)}${RESET}\r\n`);
  }

  private async start(): Promise<void> {
    const { task } = this.request;
    if (task.agent === 'api') {
      await this.runApi();
      return;
    }
    let program: string;
    let args: string[] = [];
    let adapter: Adapter | undefined;
    let version: string | undefined;
    if (task.agent === 'command') {
      program = task.command ?? '';
    } else {
      const install = isCliAgent(task.agent) ? await findAgent(task.agent) : undefined;
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
      adapter = ADAPTERS[install.agent];
      program = install.path;
      version = install.version;
    }
    this.header(version);
    if (task.agent === 'copilot' && task.access !== 'full' && copilotTrusts(this.request.cwd)) {
      this.end(
        1,
        `Copilot trusts this folder, so the repository's own hooks run with any task in it — they can run any command, whatever the task's access says. ` +
          `A ${ACCESS_LABEL[task.access]} task does not run here. Give it Full access, or remove this folder from Copilot's trusted folders.`,
      );
      return;
    }
    const prompt = await this.prompt();
    // Resolved before the check below, which is then the last thing between the
    // lookups and the spawn: a stop that came while any of them was in flight is seen.
    const base = await agentEnvironment();
    const env = adapter?.env ? adapter.env(base, task) : base;
    if (this.stopping) {
      this.end(130);
      return;
    }
    this.write('\r\n');

    this.answerFile = path.join(os.tmpdir(), `task-runner-ai-${process.pid}-${Date.now()}.md`);
    if (adapter) {
      args = adapter.args(task, this.answerFile);
    }
    this.reader =
      adapter?.output === 'claude'
        ? new ClaudeReader(this.sink)
        : adapter?.output === 'copilot'
          ? new CopilotReader(this.sink)
          : new TextReader(this.sink);
    this.started = Date.now();
    let child: cp.ChildProcess;
    try {
      const options: cp.SpawnOptions = {
        cwd: this.request.cwd,
        // Its own process group, so a stop reaches the commands the agent
        // started as well as the agent: killing only the parent would leave a
        // build it was running carrying on with nothing to report to.
        detached: process.platform !== 'win32',
        windowsHide: true,
      };
      if (task.agent === 'command') {
        // A command line the user wrote to be read by a shell, the way a custom
        // task's is. It was approved as written; see `aiApproval`.
        child = cp.spawn(program, { ...options, env, shell: true });
      } else {
        const [file, spawnArgs] = spawnable(program, args);
        child = cp.spawn(file, spawnArgs, { ...options, env: shellSafeEnvironment(env, program), shell: needsShell(program) });
      }
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
    child.stdout?.on('data', (chunk: string) => this.reader?.feed(chunk));
    child.stderr?.on('data', (chunk: string) => {
      this.noteModelProblem(chunk);
      const lines = chunk.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length > 0) {
        this.lastError = lines[lines.length - 1];
      }
      // Beside a stream of JSON, stderr is the one place a plain error turns up.
      this.write(adapter && adapter.output !== 'text' ? `${RED}${terminalText(chunk)}${RESET}` : terminalText(chunk));
    });
    child.on('close', (code) => void this.exited(code ?? 1));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt);
  }

  private noteModelProblem(text: string): void {
    if (!this.modelProblem && isModelProblem(text)) {
      this.modelProblem = true;
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
    const reader = this.reader;
    reader?.finish();
    const adapter = isCliAgent(task.agent) ? ADAPTERS[task.agent] : undefined;
    let answer: string | undefined;
    if (code === 0) {
      answer = adapter?.answerFile
        ? await fs.promises.readFile(this.answerFile, 'utf8').catch(() => undefined)
        : reader?.answer();
    }
    await fs.promises.rm(this.answerFile, { force: true }).catch(() => undefined);
    const said = reader?.failure();
    if (said) {
      this.lastError = said;
    }

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
        // A command of the user's own names no model of ours to change.
        task.agent !== 'command' && (this.modelProblem || reader?.modelProblem) ? 'model' : undefined,
      );
      return;
    }
    await this.finishWith(answer);
  }

  private async finishWith(answer: string): Promise<void> {
    const seconds = Math.round((Date.now() - this.started) / 1000);
    this.write(`\r\n${DIM}Finished in ${seconds} s.${RESET}\r\n`);
    this.end(0);
    await deliver(this.request, answer.trim() || '(no output)', seconds);
  }

  /**
   * A model behind an OpenAI-compatible endpoint: one request to its
   * `/chat/completions`, its answer streamed into the terminal as it comes. The
   * provider's address and key are the user's, set up on this machine — the
   * task names the provider and nothing more.
   */
  private async runApi(): Promise<void> {
    const { task } = this.request;
    const provider = apiProvider(task.provider ?? '');
    if (!provider) {
      this.end(127, `No API provider named "${task.provider}" is set up on this machine.`, 'provider');
      return;
    }
    if (!task.model) {
      this.end(1, `An API task needs a model, and "${this.request.name}" names none.`, 'model');
      return;
    }
    this.header();
    const prompt = await this.prompt();
    const key = await providerKey(provider);
    if (this.stopping) {
      this.end(130);
      return;
    }
    if (key === MOVED) {
      this.end(
        1,
        `${provider.name}'s address is not the one its key was saved for, so the key was not sent. If the new address is right, set the key again in AI providers.`,
        'provider',
      );
      return;
    }
    this.write('\r\n');
    this.started = Date.now();
    const abort = new AbortController();
    this.request_ = abort;
    let answer: { text: string } | { error: string; problem?: AgentProblem };
    let answered = false;
    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model: task.model, messages: [{ role: 'user', content: prompt }], stream: true }),
        // Not to anywhere else: a redirect would carry the prompt, and the
        // context in it, to a server nobody set up.
        redirect: 'error',
        signal: abort.signal,
      });
      answered = true;
      if (!response.ok) {
        const message = apiError(await readLimited(response));
        if (this.stopping) {
          throw new Error('stopped');
        }
        answer = {
          error: `${provider.name} answered ${response.status}${message ? `: ${message}` : ''}`,
          // A key turned away is the provider's to fix; a model it does not
          // have is the model's; an address that answers 404 to everything is
          // a wrong address, which is the provider's again.
          problem:
            response.status === 401 || response.status === 403
              ? 'provider'
              : isModelProblem(message)
                ? 'model'
                : response.status === 404
                  ? 'provider'
                  : undefined,
        };
      } else if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        answer = await this.readStream(response);
      } else {
        // A server that does not stream answers with the whole thing at once —
        // or with an error, or with a web page, all with a 200.
        answer = chatAnswer(await readLimited(response));
        if ('text' in answer) {
          this.write(terminalText(terminalSafe(answer.text)));
        }
      }
    } catch (error) {
      this.released();
      if (this.stopping) {
        this.write(`\r\n${DIM}Stopped.${RESET}\r\n`);
        this.end(130);
        return;
      }
      const message = error instanceof Error ? describeFetchError(error) : String(error);
      // Never reached is an address to fix; reached and then cut off is not.
      this.end(
        1,
        answered
          ? `${provider.name} stopped answering: ${message}`
          : `${provider.name} could not be reached at ${provider.baseUrl}: ${message}`,
        answered || /timeout/i.test(message) ? undefined : 'provider',
      );
      return;
    }
    this.released();
    if (this.stopping) {
      this.end(130);
      return;
    }
    if ('error' in answer) {
      this.end(1, answer.error, answer.problem);
      return;
    }
    await this.finishWith(answer.text);
  }

  /**
   * A server-sent event stream of chat completion chunks, written out as it
   * comes and handed back whole — or the error the stream ended with, which a
   * provider sends as an event of its own after a 200.
   */
  private async readStream(response: Response): Promise<{ text: string } | { error: string; problem?: AgentProblem }> {
    const decoder = new TextDecoder();
    const body = response.body?.getReader();
    let pending = '';
    let text = '';
    const take = (line: string): string | undefined => {
      const event = sseEvent(line);
      if (event.error) {
        return event.error;
      }
      if (event.delta) {
        text += event.delta;
        this.write(terminalText(terminalSafe(event.delta)));
        if (text.length > ANSWER_LIMIT) {
          return `the answer passed ${formatSize(ANSWER_LIMIT)} and was stopped there`;
        }
      }
      return undefined;
    };
    while (body) {
      const { value, done } = await body.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const error = take(line);
        if (error) {
          await body.cancel().catch(() => undefined);
          return { error: `${this.request.task.provider}: ${error}`, problem: isModelProblem(error) ? 'model' : undefined };
        }
      }
    }
    const error = take(pending);
    return error ? { error: `${this.request.task.provider}: ${error}` } : { text };
  }

  /** Ends the terminal's task, and says why when it failed and somebody did not ask for it. */
  private end(code: number, failure?: string, problem?: AgentProblem): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (!this.child) {
      // Ended before an agent was started — not found, or stopped while it was
      // being looked for — or an API task, which has no process to wait for.
      this.released();
    }
    if (failure !== undefined) {
      this.write(`\r\n${RED}${terminalText(failure)}${RESET}\r\n`);
    }
    for (const listener of [...endListeners]) {
      listener(this.request.key, code);
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
    if (this.request_) {
      this.request_.abort();
      return;
    }
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

function formatSize(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k chars`;
}

// --- API providers -------------------------------------------------------------

/** An OpenAI-compatible endpoint the user has set up on this machine. */
export interface ApiProvider {
  name: string;
  baseUrl: string;
}

/**
 * The providers set up on this machine, out of `aiProviders` — a machine-scoped
 * setting, so a repository's own settings cannot point a provider somewhere
 * else and have a task send it the prompt and the key.
 */
export function apiProviders(): ApiProvider[] {
  const setting = vscode.workspace.getConfiguration('taskRunnerUltimate').get<Record<string, unknown>>('aiProviders', {});
  return Object.entries(setting ?? {}).flatMap(([name, value]) => {
    const baseUrl =
      typeof value === 'string' ? value : typeof (value as { baseUrl?: unknown })?.baseUrl === 'string' ? (value as { baseUrl: string }).baseUrl : '';
    // Only one a task can name — a name `parseAiTask` would refuse makes a task
    // that never appears — and one that is an address at all.
    return validProvider(name) && /^https?:\/\/\S+$/i.test(baseUrl) ? [{ name, baseUrl }] : [];
  });
}

export function apiProvider(name: string): ApiProvider | undefined {
  return apiProviders().find((provider) => provider.name === name);
}

let secrets: vscode.SecretStorage | undefined;

/** Where providers' keys are kept: VS Code's secret storage, never a setting. */
export function setSecretStorage(storage: vscode.SecretStorage): void {
  secrets = storage;
}

const keyName = (provider: string) => `aiProviderKey:${provider}`;

/** What `providerKey` answers for a key saved for another address than the provider has now. */
export const MOVED = '\u0000moved';

/**
 * A provider's key, but only for the address it was saved with. The address is
 * a setting and the key a secret, and in a remote window the two come from
 * different places: settings from the remote machine, which a dev container's
 * own configuration can write, and secrets from this one. A key goes only where
 * it was given to go — a provider whose address has changed since gets
 * `MOVED`, and nothing is sent.
 */
export async function providerKey(provider: ApiProvider): Promise<string | undefined> {
  if (!secrets) {
    return undefined;
  }
  const stored = await Promise.resolve(secrets.get(keyName(provider.name))).catch(() => undefined);
  if (!stored) {
    return undefined;
  }
  try {
    const saved = JSON.parse(stored) as { key?: unknown; baseUrl?: unknown };
    if (typeof saved.key === 'string' && typeof saved.baseUrl === 'string') {
      return saved.baseUrl === provider.baseUrl ? saved.key : MOVED;
    }
  } catch {
    // Not one of ours.
  }
  return MOVED;
}

/** Saves a provider's key for the address it has now; `undefined` removes it. */
export async function setProviderKey(provider: ApiProvider, key: string | undefined): Promise<void> {
  if (!secrets) {
    return;
  }
  await (key
    ? secrets.store(keyName(provider.name), JSON.stringify({ key, baseUrl: provider.baseUrl }))
    : secrets.delete(keyName(provider.name)));
}

/** The models a provider lists at `/models` — what its key can use, or every model a local server has loaded. */
export async function apiModels(provider: ApiProvider): Promise<AgentModel[]> {
  const key = await providerKey(provider);
  if (key === MOVED) {
    return [];
  }
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return [];
    }
    const body = JSON.parse(await readLimited(response)) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
    return (Array.isArray(body?.data) ? body.data : [])
      .filter((model): model is { id: string; owned_by?: unknown } => typeof model?.id === 'string')
      .map((model) => ({ name: model.id, description: typeof model.owned_by === 'string' ? model.owned_by : undefined }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** The text of a chat completion, or of one chunk of one: `message` whole, `delta` streamed. */
export function chatText(body: unknown, part: 'message' | 'delta'): string {
  const choice = (body as { choices?: Array<Record<string, { content?: unknown }>> } | undefined)?.choices?.[0];
  const content = choice?.[part]?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * One line of a server-sent event stream: the text it adds, or the error it
 * carries — which providers send as an event of their own, after a 200 — or
 * neither, for `[DONE]`, a comment or a blank.
 */
export function sseEvent(line: string): { delta?: string; error?: string } {
  const data = /^data:\s?(.*)$/.exec(line.trim())?.[1];
  if (!data || data === '[DONE]') {
    return {};
  }
  try {
    const body = JSON.parse(data) as { error?: unknown };
    if (body && typeof body === 'object' && body.error !== undefined) {
      return { error: apiError(data) };
    }
    return { delta: chatText(body, 'delta') };
  } catch {
    return {};
  }
}

/** The text a line adds — what `sseEvent` says, without the error. */
export function sseDelta(line: string): string {
  return sseEvent(line).delta ?? '';
}

/**
 * A whole, unstreamed chat completion read as its answer — or as what went
 * wrong, when the body is an error, or not JSON at all: a 200 with a web page
 * is an address that is not an API, and saying "(no output)" would pass it off
 * as an answer.
 */
export function chatAnswer(body: string): { text: string } | { error: string; problem?: AgentProblem } {
  let data: { error?: unknown; choices?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    return { error: `the answer was not an API's: ${plain(body).slice(0, 120)}`, problem: 'provider' };
  }
  if (data?.error !== undefined) {
    const message = apiError(body);
    return { error: message, problem: isModelProblem(message) ? 'model' : undefined };
  }
  if (!Array.isArray(data?.choices)) {
    return { error: 'the answer held no choices — is this an OpenAI-compatible API?', problem: 'provider' };
  }
  return { text: chatText(data, 'message') };
}

/** Most an answer may run to before it is stopped: a runaway model, or a server that never ends its stream. */
const ANSWER_LIMIT = 5_000_000;

/** A response body as text, up to `ANSWER_LIMIT`. */
async function readLimited(response: Response): Promise<string> {
  const body = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (body) {
    const { value, done } = await body.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
    if (text.length > ANSWER_LIMIT) {
      await body.cancel().catch(() => undefined);
      break;
    }
  }
  return text;
}

/** What a failed fetch says, with the cause undici keeps out of its message — `ECONNREFUSED`, a certificate. */
function describeFetchError(error: Error): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
}

/** What an API said went wrong, out of the body of its error response. */
export function apiError(body: string): string {
  try {
    const data = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof data.error === 'string' ? data.error : data.error?.message ?? data.message;
    if (typeof message === 'string') {
      return plain(message).slice(0, 300);
    }
  } catch {
    // Not JSON — a proxy's HTML page, or plain text.
  }
  return plain(body).slice(0, 300);
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
      await showReport(report);
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
    await showReport(report);
  } else if (picked === copy) {
    await vscode.env.clipboard.writeText(answer);
  }
}

/**
 * A report opened beside the editor, and the editor given its focus back. The
 * preview would otherwise take the focus, and with it the active editor that
 * the next task's `${selection}` and `${file}` are read from.
 */
async function showReport(report: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  await vscode.commands.executeCommand('markdown.showPreviewToSide', report);
  if (editor) {
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
  }
}

/**
 * An answer as a report says it: with no image in it the preview would fetch.
 * A Markdown preview loads a remote image as it opens, and an answer steered by
 * what the model read can name an image whose address carries the rest of the
 * context — the clipboard, the diff — off to whoever asked for it. An image
 * stays as its text and its link, which is there to be clicked or not.
 */
function withoutImages(answer: string): string {
  return answer.replace(/!\[/g, '\\![').replace(/<(img|image|svg|picture|video|audio|source|iframe)\b/gi, '&lt;$1');
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
  const body = [
    `# ${name}`,
    '',
    `${agentText(task)} · ${accessText(task)} · ${new Date().toLocaleString()} · ${seconds} s`,
    '',
    '---',
    '',
    withoutImages(answer),
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
