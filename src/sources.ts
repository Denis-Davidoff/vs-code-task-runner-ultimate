import * as path from 'path';
import * as vscode from 'vscode';
import { parseToml, tomlTable, tomlTables } from './toml';

/**
 * Every kind of file a task can be read out of. The kind decides the parser and,
 * with it, how the task is launched — which is why it travels on the entry
 * itself rather than being guessed back from the file name later.
 */
export type SourceKind =
  | 'npm'
  | 'deno'
  | 'composer'
  | 'cargo'
  | 'cargo-make'
  | 'pyproject'
  | 'pipfile'
  | 'tox'
  | 'nox'
  | 'make'
  | 'just'
  | 'taskfile'
  | 'go'
  | 'mise';

/** What the `sources` setting switches on and off: a language or a task runner, not a file. */
export type Ecosystem = 'node' | 'php' | 'rust' | 'python' | 'make' | 'just' | 'task' | 'go' | 'mise';

export const ALL_ECOSYSTEMS: ReadonlyArray<Ecosystem> = [
  'node',
  'rust',
  'python',
  'make',
  'just',
  'task',
  'go',
  'php',
  'mise',
];

const ECOSYSTEM_OF: Record<SourceKind, Ecosystem> = {
  npm: 'node',
  deno: 'node',
  composer: 'php',
  cargo: 'rust',
  'cargo-make': 'rust',
  pyproject: 'python',
  pipfile: 'python',
  tox: 'python',
  nox: 'python',
  make: 'make',
  just: 'just',
  taskfile: 'task',
  go: 'go',
  mise: 'mise',
};

/**
 * File name -> what it holds. Matching on the whole name rather than an
 * extension is what keeps `Makefile.toml` (cargo-make) apart from `Makefile`,
 * and is why the case variants are spelled out: the scan glob is case-sensitive
 * on Linux, and both `Makefile` and `makefile` are in the wild.
 */
const MANIFEST_KINDS: Record<string, SourceKind> = {
  'package.json': 'npm',
  'deno.json': 'deno',
  'deno.jsonc': 'deno',
  'composer.json': 'composer',
  'Cargo.toml': 'cargo',
  'Makefile.toml': 'cargo-make',
  'pyproject.toml': 'pyproject',
  Pipfile: 'pipfile',
  'tox.ini': 'tox',
  'noxfile.py': 'nox',
  Makefile: 'make',
  makefile: 'make',
  GNUmakefile: 'make',
  justfile: 'just',
  Justfile: 'just',
  '.justfile': 'just',
  'Taskfile.yml': 'taskfile',
  'Taskfile.yaml': 'taskfile',
  'Taskfile.dist.yml': 'taskfile',
  'Taskfile.dist.yaml': 'taskfile',
  'taskfile.yml': 'taskfile',
  'taskfile.yaml': 'taskfile',
  'go.mod': 'go',
  'mise.toml': 'mise',
  '.mise.toml': 'mise',
};

export const MANIFEST_GLOB = `**/{${Object.keys(MANIFEST_KINDS).join(',')}}`;

export const DEFAULT_EXCLUDE =
  '**/{node_modules,.git,dist,out,build,.next,coverage,target,vendor,__pycache__,.venv,venv,.tox,.nox,.mypy_cache,.pytest_cache}/**';

/** How each Node runner invokes a named script. */
const RUNNERS: Record<PackageManager, (script: string) => string> = {
  npm: (script) => `npm run ${script}`,
  yarn: (script) => `yarn ${script}`,
  pnpm: (script) => `pnpm run ${script}`,
  bun: (script) => `bun run ${script}`,
  deno: (script) => `deno task ${script}`,
};

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno';

/**
 * Lock and config files that identify a Node runner, checked in this order
 * within a directory. Deno comes last: in a project that also has a
 * package.json, an npm-family lock file is the better signal for how to run its
 * scripts.
 */
const DETECTION_FILES: ReadonlyArray<[string, PackageManager]> = [
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['bunfig.toml', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['.yarnrc.yml', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['deno.lock', 'deno'],
  ['deno.json', 'deno'],
  ['deno.jsonc', 'deno'],
];

/** Order in which the `engines` field is consulted; npm last, as it is the fallback anyway. */
const ENGINE_KEYS: ReadonlyArray<PackageManager> = ['deno', 'bun', 'pnpm', 'yarn', 'npm'];

/** The tool a `[project.scripts]` entry has to be run through, and the lock file that names it. */
type PythonRunner = 'uv' | 'poetry' | 'pdm' | 'rye' | 'pipenv' | 'hatch';

const PYTHON_LOCKS: ReadonlyArray<[string, PythonRunner]> = [
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['pdm.lock', 'pdm'],
  ['requirements.lock', 'rye'],
  ['Pipfile.lock', 'pipenv'],
];

/**
 * Everything a scan depends on: the manifests it reads tasks from, plus the lock
 * and config files runner detection consults. Watching only the manifests would
 * leave a package running under the wrong runner after a lock file appears, so
 * both go through the same watcher.
 */
export const WATCH_GLOB = `**/{${[
  ...new Set([
    ...Object.keys(MANIFEST_KINDS),
    ...DETECTION_FILES.map(([file]) => file),
    ...PYTHON_LOCKS.map(([file]) => file),
  ]),
].join(',')}}`;

export interface ScriptEntry {
  /** Stable identity of a task: its manifest plus the task name. */
  key: string;
  /** Task name as written in the manifest. */
  name: string;
  /** What the task does, shown as dimmed text: the raw command, or its description. */
  command: string;
  /** The file the task came from. */
  manifest: vscode.Uri;
  /** What kind of file that is, which is what decides the parser and the runner. */
  kind: SourceKind;
  /**
   * The shell command to run. Left undefined for package.json scripts alone,
   * whose runner is resolved on demand — a lock file or a `packageManager`
   * field can change it without the script itself changing.
   */
  exec?: string;
  /** Directory the task must run in. */
  cwd: vscode.Uri;
  /** Manifest path relative to its workspace folder. */
  location: string;
  /** Directory part of `location`, empty for a manifest at the workspace root. */
  directory: string;
  /** Name the manifest gives its package, if it names one. */
  packageName?: string;
}

/** What a parser hands back for one manifest. */
interface RawTask {
  name: string;
  command: string;
  /** Undefined only for package.json, see `ScriptEntry.exec`. */
  exec?: string;
}

interface ParsedManifest {
  packageName?: string;
  tasks: RawTask[];
  /** package.json fields that runner detection reads, kept to avoid a second read. */
  hints?: NodeHints;
}

interface NodeHints {
  packageManager?: string;
  engines?: Record<string, unknown>;
}

/**
 * Ceiling on manifests read in one scan. Every hit is opened and parsed, and its
 * directory is stat-walked for lock files, so this bounds the work a
 * pathological workspace can ask for. Reaching it is reported rather than
 * silently truncating the list.
 */
const MAX_MANIFESTS = 2000;
/** Manifests above this size are skipped: nothing hand-written comes close. */
const MAX_MANIFEST_BYTES = 1_000_000;
/** The truncation warning is shown once per window, not once per scan. */
let warnedAboutTruncation = false;

let cache: ScriptEntry[] | undefined;
/**
 * The scan that is currently running, if one is. Two views draw this list now,
 * and both ask for their roots the moment they are shown, which is before the
 * first scan has anything to put in `cache`. Handing the second caller the first
 * one's promise is what keeps that from walking the workspace twice.
 */
let scanning: Promise<ScriptEntry[]> | undefined;
/**
 * Bumped by every `resetSources`. A scan reads it on the way in and checks it on
 * the way out, so one that was already walking the disk when a manifest changed
 * hands its answer back to whoever asked but does not become the cache the next
 * caller reads — the fresher scan's answer is the one that stands.
 */
let generation = 0;
/** Node package manager per package directory, detected while scanning. */
const detected = new Map<string, PackageManager>();
/** package.json detection fields, by manifest URI, collected during the scan. */
const nodeHints = new Map<string, NodeHints>();

/**
 * Drops everything derived from the manifests.
 *
 * The detected runners go too: a package.json carries `packageManager` and
 * `engines`, so a change to it can move a package to a different runner, and a
 * stale entry would keep launching scripts with the old one.
 */
export function resetSources(): void {
  cache = undefined;
  // A scan already in flight was started against the manifests as they were, so
  // it is dropped rather than awaited: whoever it belongs to still gets its
  // answer, and the next caller starts a scan that sees the change.
  scanning = undefined;
  generation++;
  detected.clear();
  nodeHints.clear();
}

export async function collectScripts(): Promise<ScriptEntry[]> {
  if (cache) {
    return cache;
  }
  if (scanning) {
    return scanning;
  }

  const scan = runScan();
  scanning = scan;
  try {
    return await scan;
  } finally {
    // Only if it is still ours: an `invalidate` during the scan has already
    // cleared the slot for a fresher one, and clearing it again would drop that.
    if (scanning === scan) {
      scanning = undefined;
    }
  }
}

async function runScan(): Promise<ScriptEntry[]> {
  const started = generation;
  const exclude = setting<string>('exclude') || DEFAULT_EXCLUDE;
  const enabled = enabledEcosystems();
  const manifests = await vscode.workspace.findFiles(MANIFEST_GLOB, exclude, MAX_MANIFESTS);

  // Hitting the cap means the list on screen is incomplete, which is worth
  // saying out loud — once per window, not on every rescan.
  if (manifests.length === MAX_MANIFESTS && !warnedAboutTruncation) {
    warnedAboutTruncation = true;
    void vscode.window.showWarningMessage(
      `Task & Script Explorer stopped after ${MAX_MANIFESTS} manifests, so some tasks are missing. ` +
        'Widen "taskRunnerUltimate.exclude" to skip the ones you do not need.',
    );
  }

  manifests.sort((a, b) => a.fsPath.length - b.fsPath.length || a.fsPath.localeCompare(b.fsPath));

  const entries: ScriptEntry[] = [];

  for (const manifest of manifests) {
    const kind = MANIFEST_KINDS[path.posix.basename(manifest.path)];
    if (!kind || !enabled.has(ECOSYSTEM_OF[kind])) {
      continue;
    }

    const cwd = manifest.with({ path: path.posix.dirname(manifest.path) });
    const parsed = await parseManifest(manifest, kind, cwd);
    if (!parsed || parsed.tasks.length === 0) {
      continue;
    }
    if (parsed.hints) {
      nodeHints.set(manifest.toString(), parsed.hints);
    }

    const folder = vscode.workspace.getWorkspaceFolder(manifest);
    const relative = folder ? path.relative(folder.uri.fsPath, manifest.fsPath) : manifest.fsPath;
    const location = relative.split(path.sep).join('/') || path.posix.basename(manifest.path);
    const directory = location.includes('/') ? location.slice(0, location.lastIndexOf('/')) : '';

    // A key is what a favorite, a running task and a tree row are all matched
    // by, so a manifest that names the same task twice — which nothing stops a
    // hand-written Makefile or Taskfile from doing — keeps only the first.
    const taken = new Set<string>();

    for (const task of parsed.tasks) {
      if (taken.has(task.name)) {
        continue;
      }
      taken.add(task.name);
      entries.push({
        key: scriptKey(manifest.toString(), task.name),
        name: task.name,
        // A description can be a multi-line string in every format that has one,
        // and both surfaces this is shown on are a single line.
        command: task.command.replace(/\s+/g, ' ').trim(),
        exec: task.exec,
        manifest,
        kind,
        cwd,
        location,
        directory,
        packageName: parsed.packageName,
      });
    }
  }

  if (started === generation) {
    cache = entries;
    await detectPackageManagers(entries);
  }
  return entries;
}

export function scriptKey(manifest: string, name: string): string {
  return `${manifest}::${name}`;
}

function setting<T>(key: string, scope?: vscode.Uri): T | undefined {
  return vscode.workspace.getConfiguration('taskRunnerUltimate', scope).get<T>(key);
}

/** A string-array setting, with the enum values it is allowed to hold when one is given. */
function settingList(key: string, fallback: ReadonlyArray<string>): string[] {
  const value = setting<unknown>(key);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [...fallback];
}

function enabledEcosystems(): Set<Ecosystem> {
  const configured = settingList('sources', ALL_ECOSYSTEMS);
  return new Set(configured.filter((item): item is Ecosystem => ALL_ECOSYSTEMS.includes(item as Ecosystem)));
}

// --- parsing -----------------------------------------------------------------

async function parseManifest(
  uri: vscode.Uri,
  kind: SourceKind,
  cwd: vscode.Uri,
): Promise<ParsedManifest | undefined> {
  const text = await readText(uri);
  if (text === undefined) {
    return undefined;
  }

  switch (kind) {
    case 'npm':
      return parsePackageJson(text);
    case 'deno':
      return parseDenoJson(text);
    case 'composer':
      return parseComposerJson(text);
    case 'cargo':
      return parseCargo(text, cwd);
    case 'cargo-make':
      return parseCargoMake(text);
    case 'pyproject':
      return parsePyproject(text, cwd);
    case 'pipfile':
      return parsePipfile(text);
    case 'tox':
      return parseTox(text);
    case 'nox':
      return parseNoxfile(text);
    case 'make':
      return parseMakefile(text);
    case 'just':
      return parseJustfile(text);
    case 'taskfile':
      return parseTaskfile(text);
    case 'go':
      return parseGoMod(text, cwd);
    case 'mise':
      return parseMise(text);
    default:
      return undefined;
  }
}

// --- Node, Deno and PHP ------------------------------------------------------

function parsePackageJson(text: string): ParsedManifest | undefined {
  const json = parseJsonc(text) as Record<string, unknown> | undefined;
  const scripts = json?.scripts;
  if (!scripts || typeof scripts !== 'object') {
    return undefined;
  }
  const tasks: RawTask[] = [];
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    const command = commandOf(value);
    if (command !== undefined) {
      // No `exec`: the runner is resolved per package, on demand.
      tasks.push({ name, command });
    }
  }
  return {
    tasks,
    packageName: typeof json?.name === 'string' ? json.name : undefined,
    hints: {
      packageManager: typeof json?.packageManager === 'string' ? json.packageManager : undefined,
      engines:
        json?.engines && typeof json.engines === 'object'
          ? (json.engines as Record<string, unknown>)
          : undefined,
    },
  };
}

function parseDenoJson(text: string): ParsedManifest | undefined {
  const json = parseJsonc(text) as Record<string, unknown> | undefined;
  const tasks = json?.tasks;
  if (!tasks || typeof tasks !== 'object') {
    return undefined;
  }
  const out: RawTask[] = [];
  for (const [name, value] of Object.entries(tasks as Record<string, unknown>)) {
    const command = commandOf(value);
    if (command !== undefined) {
      out.push({ name, command });
    }
  }
  return { tasks: out, packageName: typeof json?.name === 'string' ? json.name : undefined };
}

/**
 * Composer's `scripts` field doubles as its event hook table — `post-update-cmd`
 * and the rest fire on their own and are not things anyone runs by hand, so they
 * are left out of the list.
 */
const COMPOSER_EVENTS = new Set([
  'pre-install-cmd',
  'post-install-cmd',
  'pre-update-cmd',
  'post-update-cmd',
  'pre-status-cmd',
  'post-status-cmd',
  'pre-archive-cmd',
  'post-archive-cmd',
  'pre-autoload-dump',
  'post-autoload-dump',
  'post-root-package-install',
  'post-create-project-cmd',
  'pre-operations-exec',
  'pre-package-install',
  'post-package-install',
  'pre-package-update',
  'post-package-update',
  'pre-package-uninstall',
  'post-package-uninstall',
  'pre-pool-create',
  'init',
  'command',
]);

function parseComposerJson(text: string): ParsedManifest | undefined {
  const json = parseJsonc(text) as Record<string, unknown> | undefined;
  const scripts = json?.scripts;
  if (!scripts || typeof scripts !== 'object') {
    return undefined;
  }
  const descriptions =
    json?.['scripts-descriptions'] && typeof json['scripts-descriptions'] === 'object'
      ? (json['scripts-descriptions'] as Record<string, unknown>)
      : {};

  const tasks: RawTask[] = [];
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (COMPOSER_EVENTS.has(name)) {
      continue;
    }
    const described = descriptions[name];
    const command = (typeof described === 'string' ? described : undefined) ?? describe(value);
    tasks.push({
      name,
      command: command ?? `composer ${name}`,
      // `run-script` rather than the bare form, so a script named after a
      // built-in subcommand still reaches the script.
      exec: `composer run-script ${shellArg(name)}`,
    });
  }
  return { tasks, packageName: typeof json?.name === 'string' ? json.name : undefined };
}

// --- Rust --------------------------------------------------------------------

/**
 * Cargo has no user-defined scripts, so the rows for a crate are derived from
 * what the crate actually is. Only the plain subcommands are listed by default;
 * `run` is not one of them, because whether it works — and with which target —
 * is a property of the crate, handled separately below.
 */
const DEFAULT_CARGO_COMMANDS: ReadonlyArray<string> = ['run', 'build', 'test', 'clippy', 'fmt'];

const CARGO_COMMANDS: Record<string, string> = {
  build: 'cargo build',
  test: 'cargo test',
  check: 'cargo check',
  clippy: 'cargo clippy --all-targets',
  fmt: 'cargo fmt',
  bench: 'cargo bench',
  doc: 'cargo doc --open',
  clean: 'cargo clean',
  update: 'cargo update',
};

async function parseCargo(text: string, cwd: vscode.Uri): Promise<ParsedManifest | undefined> {
  const toml = parseToml(text);
  if (!toml) {
    return undefined;
  }
  const pkg = tomlTable(toml, 'package');
  const workspace = tomlTable(toml, 'workspace');
  if (!pkg && !workspace) {
    return undefined;
  }

  // `name = { workspace = true }` is legal and inherits from the workspace root,
  // which we have no cheap way to resolve — the group falls back to its path.
  const packageName = typeof pkg?.name === 'string' ? pkg.name : undefined;
  const commands = settingList('cargoCommands', DEFAULT_CARGO_COMMANDS);
  const tasks: RawTask[] = [];

  if (commands.includes('run') && pkg) {
    // A crate with no binary cannot be run at all, and one with several needs to
    // be told which — so a bare `run` row is only correct for a single binary.
    const bins = await cargoBins(toml, cwd, packageName);
    if (bins.length === 1) {
      tasks.push({ name: 'run', command: 'cargo run' });
    } else {
      for (const bin of bins) {
        tasks.push({ name: `run: ${bin}`, command: `cargo run --bin ${bin}` });
      }
    }
    for (const example of await cargoExamples(toml, cwd)) {
      tasks.push({ name: `example: ${example}`, command: `cargo run --example ${example}` });
    }
  }

  for (const command of commands) {
    if (command === 'run') {
      continue;
    }
    tasks.push({ name: command, command: CARGO_COMMANDS[command] ?? `cargo ${command}` });
  }

  // For cargo the command shown and the command run are the same thing.
  return { packageName, tasks: tasks.map((task) => ({ ...task, exec: task.command })) };
}

/**
 * The crate's binaries: the ones `[[bin]]` declares, plus the two cargo finds on
 * its own — `src/main.rs`, named after the package, and every `src/bin/*.rs`.
 */
async function cargoBins(
  toml: Record<string, unknown>,
  cwd: vscode.Uri,
  packageName: string | undefined,
): Promise<string[]> {
  const bins: string[] = [];
  const add = (name: string) => {
    if (name && !bins.includes(name)) {
      bins.push(name);
    }
  };

  // `src/main.rs` first: it is the crate's own program, and the one anyone
  // reaching for "run" means. Cargo finds it whether or not `[[bin]]` sections
  // are present, so the two lists are additive rather than exclusive.
  if (packageName && (await exists(vscode.Uri.joinPath(cwd, 'src', 'main.rs')))) {
    add(packageName);
  }
  for (const bin of tomlTables(toml, 'bin')) {
    if (typeof bin.name === 'string') {
      add(bin.name);
    }
  }
  for (const [name, type] of await listDirectory(vscode.Uri.joinPath(cwd, 'src', 'bin'))) {
    if (type === vscode.FileType.File && name.endsWith('.rs')) {
      add(name.slice(0, -3));
    } else if (type === vscode.FileType.Directory) {
      add(name);
    }
  }
  return bins;
}

async function cargoExamples(toml: Record<string, unknown>, cwd: vscode.Uri): Promise<string[]> {
  const examples: string[] = [];
  const add = (name: string) => {
    if (name && !examples.includes(name)) {
      examples.push(name);
    }
  };

  for (const example of tomlTables(toml, 'example')) {
    if (typeof example.name === 'string') {
      add(example.name);
    }
  }
  for (const [name, type] of await listDirectory(vscode.Uri.joinPath(cwd, 'examples'))) {
    if (type === vscode.FileType.File && name.endsWith('.rs')) {
      add(name.slice(0, -3));
    } else if (type === vscode.FileType.Directory) {
      add(name);
    }
  }
  return examples;
}

function parseCargoMake(text: string): ParsedManifest | undefined {
  const tasks = tomlTable(parseToml(text), 'tasks');
  if (!tasks) {
    return undefined;
  }
  const out: RawTask[] = [];
  for (const [name, value] of Object.entries(tasks)) {
    const task = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    if (task.private === true || task.disabled === true) {
      continue;
    }
    out.push({
      name,
      command: describe(task) ?? `cargo make ${name}`,
      exec: `cargo make ${shellArg(name)}`,
    });
  }
  return { tasks: out };
}

// --- Python ------------------------------------------------------------------

async function parsePyproject(text: string, cwd: vscode.Uri): Promise<ParsedManifest | undefined> {
  const toml = parseToml(text);
  if (!toml) {
    return undefined;
  }

  const tasks: RawTask[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: unknown, exec: string, fallback: string) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    tasks.push({ name, command: describe(value) ?? fallback, exec });
  };

  // Each of these tables names its own runner, so nothing has to be detected:
  // a task under [tool.pdm.scripts] is a pdm task wherever it lives.
  for (const [name, value] of tableEntries(toml, 'tool', 'poetry', 'scripts')) {
    add(name, value, `poetry run ${shellArg(name)}`, `poetry run ${name}`);
  }
  for (const [name, value] of tableEntries(toml, 'tool', 'pdm', 'scripts')) {
    // `_` holds options shared by every script rather than a script of its own.
    if (name !== '_') {
      add(name, value, `pdm run ${shellArg(name)}`, `pdm run ${name}`);
    }
  }
  for (const [name, value] of tableEntries(toml, 'tool', 'rye', 'scripts')) {
    add(name, value, `rye run ${shellArg(name)}`, `rye run ${name}`);
  }

  // poethepoet is normally installed into the project's own environment, so it
  // is reached through poetry when the project uses poetry.
  const poe = tomlTable(toml, 'tool', 'poetry') ? 'poetry run poe' : 'poe';
  for (const [name, value] of tableEntries(toml, 'tool', 'poe', 'tasks')) {
    add(name, value, `${poe} ${shellArg(name)}`, `${poe} ${name}`);
  }

  // Hatch keeps one script table per environment; the default one is addressed
  // without a prefix, the rest as `env:script`.
  const envs = tomlTable(toml, 'tool', 'hatch', 'envs');
  for (const env of Object.keys(envs ?? {})) {
    for (const [name, value] of tableEntries(toml, 'tool', 'hatch', 'envs', env, 'scripts')) {
      const target = env === 'default' ? name : `${env}:${name}`;
      add(target, value, `hatch run ${shellArg(target)}`, `hatch run ${target}`);
    }
  }

  // [project.scripts] is a list of console entry points rather than tasks: they
  // only exist inside the project's environment, so they are listed only when
  // something is known to be able to enter it.
  const runner = await pythonRunner(toml, cwd);
  if (runner) {
    for (const [name, value] of tableEntries(toml, 'project', 'scripts')) {
      add(name, value, `${runner} run ${shellArg(name)}`, `${runner} run ${name}`);
    }
  }

  const project = tomlTable(toml, 'project');
  const poetry = tomlTable(toml, 'tool', 'poetry');
  const packageName =
    (typeof project?.name === 'string' ? project.name : undefined) ??
    (typeof poetry?.name === 'string' ? poetry.name : undefined);

  return { tasks, packageName };
}

async function pythonRunner(
  toml: Record<string, unknown>,
  cwd: vscode.Uri,
): Promise<PythonRunner | undefined> {
  const configured = setting<string>('pythonRunner');
  if (configured === 'none') {
    return undefined;
  }
  if (configured && configured !== 'auto') {
    return configured as PythonRunner;
  }

  for (const [file, runner] of PYTHON_LOCKS) {
    if (await exists(vscode.Uri.joinPath(cwd, file))) {
      return runner;
    }
  }
  // No lock file: fall back to whichever tool the manifest itself configures.
  const tools: ReadonlyArray<[string, PythonRunner]> = [
    ['uv', 'uv'],
    ['poetry', 'poetry'],
    ['pdm', 'pdm'],
    ['rye', 'rye'],
    ['hatch', 'hatch'],
  ];
  for (const [table, runner] of tools) {
    if (tomlTable(toml, 'tool', table)) {
      return runner;
    }
  }
  return undefined;
}

function parsePipfile(text: string): ParsedManifest | undefined {
  const scripts = tomlTable(parseToml(text), 'scripts');
  if (!scripts) {
    return undefined;
  }
  const tasks: RawTask[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    tasks.push({
      name,
      command: describe(value) ?? `pipenv run ${name}`,
      exec: `pipenv run ${shellArg(name)}`,
    });
  }
  return { tasks };
}

/**
 * tox.ini is also a place other tools keep their configuration, so it counts as
 * a tox file only once it holds tox's own sections.
 */
function parseTox(text: string): ParsedManifest | undefined {
  const sections = parseIni(text);
  const isTox = sections.some((section) => section.name === 'tox' || section.name.startsWith('testenv'));
  if (!isTox) {
    return undefined;
  }

  const names: string[] = [];
  const add = (name: string) => {
    if (name && !names.includes(name)) {
      names.push(name);
    }
  };

  const tox = sections.find((section) => section.name === 'tox');
  const list = tox?.options.get('envlist') ?? tox?.options.get('env_list') ?? '';
  for (const entry of list.split(/[,\n]/)) {
    const name = entry.trim();
    // Generative names — `py{38,39}-django{42}` — stand for a matrix rather than
    // an environment, and expanding one here would invent environments that the
    // file never names. Both braces are checked because the split above lands in
    // the middle of one.
    if (name && !/[{}]/.test(name)) {
      add(name);
    }
  }
  for (const section of sections) {
    if (section.name.startsWith('testenv:')) {
      add(section.name.slice('testenv:'.length).trim());
    }
  }

  return {
    tasks: names.map((name) => {
      const section = sections.find((item) => item.name === `testenv:${name}`);
      const description = section?.options.get('description');
      return {
        name,
        command: description || `tox -e ${name}`,
        exec: `tox -e ${shellArg(name)}`,
      };
    }),
  };
}

/**
 * Nox sessions are Python functions, so they are read off the decorators rather
 * than parsed: `@nox.session` (or a bare `@session`) on the function above.
 */
function parseNoxfile(text: string): ParsedManifest | undefined {
  const tasks: RawTask[] = [];
  let armed = false;
  let named: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*@(nox\.)?session\b/.test(line)) {
      armed = true;
    }
    if (armed) {
      // `@nox.session(name="lint")` renames the session; the decorator can span
      // several lines, so the name is looked for on all of them.
      const explicit = /\bname\s*=\s*["']([^"']+)["']/.exec(line);
      if (explicit) {
        named = explicit[1];
      }
      const definition = /^\s*def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (definition) {
        const name = named ?? definition[1];
        tasks.push({ name, command: `nox -s ${name}`, exec: `nox -s ${shellArg(name)}` });
        armed = false;
        named = undefined;
      }
    }
  }

  return tasks.length > 0 ? { tasks } : undefined;
}

// --- Make --------------------------------------------------------------------

/**
 * Target lines: one or more names, a single or double colon, then prerequisites.
 * The `(?!=)` is what keeps `CFLAGS := -O2` out, and disallowing `=` in the name
 * does the same for the other assignment forms.
 *
 * Exported so `locate.ts` finds the line a target is on with the same rule that
 * put it in the list.
 */
export const MAKE_TARGET = /^([^\s:#=][^:=#]*?)\s*::?(?!=)\s*(.*)$/;
/** `build: deps ## Build everything` — the convention every self-documenting Makefile uses. */
const MAKE_DOC = /##\s*(.*)$/;

function parseMakefile(text: string): ParsedManifest | undefined {
  const tasks: RawTask[] = [];
  const seen = new Set<string>();
  let doc = '';

  for (const line of text.split(/\r?\n/)) {
    // A tab starts a recipe body, which can hold anything at all.
    if (line.startsWith('\t')) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      doc = '';
      continue;
    }
    if (trimmed.startsWith('#')) {
      const comment = /^#+\s*(.*)$/.exec(trimmed);
      doc = comment ? comment[1].trim() : '';
      continue;
    }

    const match = MAKE_TARGET.exec(line);
    if (!match) {
      doc = '';
      continue;
    }

    const inline = MAKE_DOC.exec(match[2]);
    const description = inline ? inline[1].trim() : doc;
    doc = '';

    for (const name of match[1].trim().split(/\s+/)) {
      // Skipped: pattern rules, anything built from a variable we cannot expand,
      // and the special targets — `.PHONY` and friends are declarations, not work.
      if (!name || name.startsWith('.') || name.startsWith('-') || /[%$()]/.test(name) || seen.has(name)) {
        continue;
      }
      seen.add(name);
      tasks.push({
        name,
        command: description || `make ${name}`,
        exec: `make ${shellArg(name)}`,
      });
    }
  }

  return tasks.length > 0 ? { tasks } : undefined;
}

// --- just --------------------------------------------------------------------

/**
 * A recipe starts in the first column with its name, takes parameters up to the
 * colon and dependencies after it. `(?!=)` keeps out `x := "y"`, which covers
 * assignments, `alias b := build` and the `set` directives in one go.
 *
 * Exported for `locate.ts`, as MAKE_TARGET above is.
 */
export const JUST_RECIPE = /^@?([A-Za-z_][A-Za-z0-9_-]*)([^:\n]*):(?!=)/;

function parseJustfile(text: string): ParsedManifest | undefined {
  const tasks: RawTask[] = [];
  let doc = '';
  let priv = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      doc = '';
      priv = false;
      continue;
    }
    // Indented lines are recipe bodies.
    if (/^\s/.test(line)) {
      continue;
    }
    if (line.startsWith('#')) {
      doc = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (line.startsWith('[')) {
      // Attributes sit above the recipe they apply to.
      priv = priv || /\[\s*private\s*\]/.test(line);
      const documented = /\[\s*doc\s*\(\s*['"]([^'"]*)['"]\s*\)\s*\]/.exec(line);
      if (documented) {
        doc = documented[1];
      }
      continue;
    }

    const match = JUST_RECIPE.exec(line);
    if (!match) {
      doc = '';
      priv = false;
      continue;
    }

    const name = match[1];
    const parameters = match[2].trim();
    // The comment and the attributes above belong to this recipe either way.
    const description = doc;
    const hidden = priv || name.startsWith('_');
    doc = '';
    priv = false;
    if (hidden) {
      continue;
    }
    tasks.push({
      name,
      command: description || `just ${name}${parameters ? ` ${parameters}` : ''}`,
      exec: `just ${shellArg(name)}`,
    });
  }

  return tasks.length > 0 ? { tasks } : undefined;
}

// --- Taskfile (go-task) ------------------------------------------------------

/**
 * Only the task names are needed, and they are the keys one level under a
 * top-level `tasks:` — so the block is found by indentation rather than by
 * parsing YAML, which would mean bundling a parser for a list of keys.
 */
function parseTaskfile(text: string): ParsedManifest | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^tasks:\s*(#.*)?$/.test(line));
  if (start < 0) {
    return undefined;
  }

  const block: Array<{ name: string; body: string[] }> = [];
  let indent: number | undefined;
  let current: { name: string; body: string[] } | undefined;

  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width === 0) {
      break;
    }
    if (indent === undefined) {
      indent = width;
    }
    if (width > indent) {
      current?.body.push(line.trim());
      continue;
    }
    // A YAML key ends at the last colon that is followed by a space or the end
    // of the line, which is what keeps namespaced names like `docker:build`.
    const key = /^(.*?):(\s|$)/.exec(line.trim());
    if (!key) {
      continue;
    }
    current = { name: key[1].trim().replace(/^["']|["']$/g, ''), body: [] };
    block.push(current);
  }

  const tasks: RawTask[] = [];
  for (const entry of block) {
    if (!entry.name || entry.body.some((line) => /^internal:\s*true\b/.test(line))) {
      continue;
    }
    const described = entry.body.find((line) => /^(desc|summary):/.test(line));
    const description = described?.slice(described.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
    tasks.push({
      name: entry.name,
      command: description || `task ${entry.name}`,
      exec: `task ${shellArg(entry.name)}`,
    });
  }

  return tasks.length > 0 ? { tasks } : undefined;
}

// --- Go ----------------------------------------------------------------------

const DEFAULT_GO_COMMANDS: ReadonlyArray<string> = ['run', 'build', 'test', 'vet'];

const GO_COMMANDS: Record<string, string> = {
  run: 'go run .',
  build: 'go build ./...',
  test: 'go test ./...',
  vet: 'go vet ./...',
  fmt: 'go fmt ./...',
  tidy: 'go mod tidy',
  generate: 'go generate ./...',
  bench: 'go test -bench=. ./...',
};

async function parseGoMod(text: string, cwd: vscode.Uri): Promise<ParsedManifest | undefined> {
  const module = /^module\s+(\S+)/m.exec(text);
  const hasMain = await exists(vscode.Uri.joinPath(cwd, 'main.go'));

  const tasks: RawTask[] = [];
  for (const command of settingList('goCommands', DEFAULT_GO_COMMANDS)) {
    // `go run .` only means something where the module root is itself a program.
    if (command === 'run' && !hasMain) {
      continue;
    }
    const exec = GO_COMMANDS[command] ?? `go ${command}`;
    tasks.push({ name: command, command: exec, exec });
  }

  return tasks.length > 0 ? { tasks, packageName: module?.[1] } : undefined;
}

// --- mise --------------------------------------------------------------------

function parseMise(text: string): ParsedManifest | undefined {
  const tasks = tomlTable(parseToml(text), 'tasks');
  if (!tasks) {
    return undefined;
  }
  const out: RawTask[] = [];
  for (const [name, value] of Object.entries(tasks)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).hide === true) {
      continue;
    }
    out.push({
      name,
      command: describe(value) ?? `mise run ${name}`,
      exec: `mise run ${shellArg(name)}`,
    });
  }
  return { tasks: out };
}

// --- shared parsing helpers --------------------------------------------------

/**
 * The one line of dimmed text a task gets. Every runner spells its task
 * definition differently — a string, a list of commands, a table with the
 * command under one of half a dozen keys — so the first thing that reads as a
 * description wins, and the command itself is the fallback.
 */
function describe(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string');
    return parts.length > 0 ? parts.join(' && ') : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const table = value as Record<string, unknown>;
  for (const key of ['help', 'description', 'desc', 'cmd', 'shell', 'script', 'call', 'run', 'composite', 'sequence', 'chain']) {
    const found = describe(table[key]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** The entries of a nested table, or nothing when any level of it is missing. */
function tableEntries(root: unknown, ...keys: string[]): Array<[string, unknown]> {
  return Object.entries(tomlTable(root, ...keys) ?? {});
}

interface IniSection {
  name: string;
  options: Map<string, string>;
}

/** Enough of the INI format for tox.ini: sections, `key = value`, indented continuations. */
function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let section: IniSection | undefined;
  let option: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) {
      continue;
    }
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = { name: header[1].trim(), options: new Map() };
      sections.push(section);
      option = undefined;
      continue;
    }
    if (!section) {
      continue;
    }
    if (/^\s/.test(line) && option) {
      section.options.set(option, `${section.options.get(option) ?? ''}\n${line.trim()}`);
      continue;
    }
    const pair = /^([^=:]+)[=:](.*)$/.exec(line);
    if (pair) {
      option = pair[1].trim();
      section.options.set(option, pair[2].trim());
    }
  }

  return sections;
}

/**
 * A script value is a plain command string, or — for Deno ≥ 2.x tasks — an
 * object carrying the command plus metadata.
 */
function commandOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const command = (value as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : undefined;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_MANIFEST_BYTES) {
      return undefined;
    }
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

/** JSON.parse that tolerates comments and trailing commas, as deno.jsonc allows both. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += char;
  }

  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The entries of a directory, or nothing at all when it does not exist. */
async function listDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
}

function shellArg(name: string): string {
  return /^[\w.:@/=+-]+$/.test(name) ? name : JSON.stringify(name);
}

// --- launching ---------------------------------------------------------------

export function commandFor(script: ScriptEntry): string {
  return script.exec ?? RUNNERS[resolvePackageManager(script)](shellArg(script.name));
}

export function resolvePackageManager(script: ScriptEntry): PackageManager {
  // A deno.json(c) task can only be run by Deno, so it ignores any override.
  if (script.kind === 'deno') {
    return 'deno';
  }

  const configured = setting<string>('packageManager', script.manifest) ?? 'auto';
  if (configured && configured !== 'auto') {
    return configured as PackageManager;
  }
  return detected.get(script.cwd.toString()) ?? 'npm';
}

async function detectPackageManagers(entries: ScriptEntry[]): Promise<void> {
  for (const entry of entries) {
    const dir = entry.cwd.toString();
    if (entry.kind !== 'npm' || detected.has(dir)) {
      continue;
    }
    const found = await detectPackageManager(entry);
    if (found) {
      detected.set(dir, found);
    }
  }
}

async function detectPackageManager(entry: ScriptEntry): Promise<PackageManager | undefined> {
  const hints = nodeHints.get(entry.manifest.toString());

  // 1. An explicit "packageManager": "<name>@<version>" field wins.
  const field = hints?.packageManager ?? '';
  const fromField = ENGINE_KEYS.find((manager) => field.startsWith(`${manager}@`));
  if (fromField) {
    return fromField;
  }

  // 2. Then the "engines" field, e.g. { "engines": { "pnpm": ">=9" } }.
  const engines = hints?.engines;
  if (engines) {
    const fromEngines = ENGINE_KEYS.find((manager) => typeof engines[manager] === 'string');
    if (fromEngines) {
      return fromEngines;
    }
  }

  // 3. Finally lock and config files, nearest-first: the package itself, then
  //    each parent up to the workspace folder, where monorepo lock files live.
  const root = vscode.workspace.getWorkspaceFolder(entry.manifest)?.uri.path;
  let current = entry.cwd;
  for (;;) {
    const found = await detectionFileManager(current);
    if (found) {
      return found;
    }
    if (root === undefined || current.path === root) {
      return undefined;
    }
    const parent = current.with({ path: path.posix.dirname(current.path) });
    if (parent.path === current.path || !parent.path.startsWith(root)) {
      return undefined;
    }
    current = parent;
  }
}

async function detectionFileManager(dir: vscode.Uri): Promise<PackageManager | undefined> {
  for (const [file, manager] of DETECTION_FILES) {
    if (await exists(vscode.Uri.joinPath(dir, file))) {
      return manager;
    }
  }
  return undefined;
}
