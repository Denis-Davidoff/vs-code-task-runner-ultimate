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
  | 'mise'
  | 'docker-compose'
  | 'dockerfile'
  | 'shell';

/** What the `sources` setting switches on and off: a language or a task runner, not a file. */
export type Ecosystem =
  | 'node'
  | 'php'
  | 'rust'
  | 'python'
  | 'make'
  | 'just'
  | 'task'
  | 'go'
  | 'mise'
  | 'docker'
  | 'shell';

/**
 * Every ecosystem, in the order the settings schema lists them. The `sources`
 * default array in package.json is written out by hand to match this one, so an
 * entry added here is added there too — and in the same place, since
 * `enumDescriptions` is matched to `enum` by position.
 *
 * Not the order the tree draws them in: that one is decided per workspace, by
 * where each ecosystem's first package sits. See `groupedByEcosystem`.
 */
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
  'docker',
  'shell',
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
  'docker-compose': 'docker',
  dockerfile: 'docker',
  shell: 'shell',
};

/**
 * The ecosystem a kind belongs to. The record above stays private — it is a
 * total map the compiler checks against `SourceKind`, and a caller that could
 * index it could also index it with something that is not a kind.
 */
export function ecosystemOf(kind: SourceKind): Ecosystem {
  return ECOSYSTEM_OF[kind];
}

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
  'docker-compose.yml': 'docker-compose',
  'docker-compose.yaml': 'docker-compose',
  'compose.yml': 'docker-compose',
  'compose.yaml': 'docker-compose',
  Dockerfile: 'dockerfile',
  dockerfile: 'dockerfile',
};

/**
 * The four names compose looks for when it is given no `-f`, in its own order of
 * preference. A file with one of these names is a compose file because of its
 * name — nothing else has to agree — and it is the only kind that gets the
 * override merged in below.
 */
const COMPOSE_DEFAULT_FILES: ReadonlyArray<string> = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

/**
 * The overrides compose merges on top of whichever of the four it picked, again
 * in its own order — and note that the order is the *same list* whatever the
 * base file was called: `compose.yaml` beside `compose.override.yml` is a pair
 * compose merges, the extensions notwithstanding.
 *
 * None of them are manifests of their own. An override declares the services the
 * base file already declares, so a group for it would be the same rows twice.
 */
const COMPOSE_OVERRIDE_FILES: ReadonlyArray<string> = [
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
];

/**
 * Everything else that is a compose file: `docker-compose.dev.yml`,
 * `compose.prod.yaml`, `docker-compose.ci.yml`. The name is a real convention
 * and the only signal there is — nothing inside a YAML file says "I am compose"
 * — so it is matched, and then `parseCompose` insists on seeing a `services:`
 * or `include:` block before it will believe a name it was not sure about.
 *
 * The pattern is deliberately tight: `compose` has to be followed by a dot. That
 * is defence in depth rather than the only defence — the scan glob below is
 * already narrow enough that `composer.yml` never reaches this test.
 */
const COMPOSE_NAME = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/;

/**
 * Any name with `.override.` in it, and not only compose's own four.
 *
 * `compose.dev.override.yml` is an override by every convention there is, and
 * running one on its own — which is what a heading of its own would offer — asks
 * compose to bring up a fragment with no image and no build. Compose merges only
 * the four it names, so only those are appended as a second `-f`; the rest are
 * simply not rows, which is what this extension's own documentation has always
 * promised about a file with `.override.` in its name.
 *
 * The token and nothing around it. Spelling out the tail instead — the
 * extension, with room for one segment before it — let a name carrying two
 * through: `compose.dev.override.local.ci.yml` matched no tail this test knew
 * and became a heading, which is the one thing the promise above rules out. What
 * it is tested against is a file name (see `manifestKind`), already known to
 * look like compose, so there is nothing else in it for `.override.` to be.
 */
const COMPOSE_OVERRIDE_NAME = /\.override\./;

/**
 * The globs that find the profile-named files above. The four default names are
 * already in `MANIFEST_KINDS`, so these only have to cover the ones carrying a
 * middle segment — which is what keeps `composer.yml` out of the scan entirely
 * rather than merely out of the list.
 */
const COMPOSE_GLOBS: ReadonlyArray<string> = [
  'compose.*.yml',
  'compose.*.yaml',
  'docker-compose.*.yml',
  'docker-compose.*.yaml',
];

// --- Dockerfile names --------------------------------------------------------

/**
 * The two conventions for a Dockerfile that is not simply `Dockerfile`:
 * `Dockerfile.dev` and `dev.Dockerfile`. Both are in the wild in roughly equal
 * measure — the first is what Docker's own documentation uses, the second is
 * what every editor's syntax highlighting recognises — so both are rows.
 *
 * Unlike compose, the name is the whole test and nothing inside the file has to
 * agree with it: a YAML file says nothing about what it is, but nothing except
 * a Dockerfile is called `Dockerfile`. `parseDockerfile` still insists on a
 * `FROM`, which is a different question — whether the file has anything to
 * build, not whether it is one.
 *
 * `Dockerfile` and `dockerfile` on their own are in `MANIFEST_KINDS` already,
 * and the alternation here deliberately does not match them a second time: a
 * name matched twice is a name whose profile would come back empty.
 */
const DOCKERFILE_NAME = /^(?:[Dd]ockerfile\.[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[Dd]ockerfile)$/;

/**
 * The profile a Dockerfile's name carries — `dev` for both `Dockerfile.dev` and
 * `dev.Dockerfile`, and nothing for a plain `Dockerfile`. It is what the image
 * tag is qualified with, so two Dockerfiles in one folder do not build over each
 * other; see `imageTag`.
 */
function dockerfileProfile(file: string): string | undefined {
  const head = /^[Dd]ockerfile\.(.+)$/.exec(file);
  const tail = /^(.+)\.[Dd]ockerfile$/.exec(file);
  return head?.[1] ?? tail?.[1];
}

/**
 * Suffixes that say the file is *about* a Dockerfile, or is one waiting to be
 * rendered — never one to build.
 *
 * `DOCKERFILE_NAME` leaves the extension unconstrained, unlike the compose
 * globs which pin `.yml`/`.yaml`, so `Dockerfile.<anything>` reaches the parser.
 * The `FROM` check there was meant to turn these away and cannot: a template
 * *is* a Dockerfile textually, and a document explaining how to write one is the
 * file most likely to quote a `FROM`. So they are refused by name, which is the
 * same thing `COMPOSE_OVERRIDE_NAME` does for a fragment that must never be a
 * heading of its own.
 *
 * Three kinds, and nothing speculative beyond them: what a merge, a patch or an
 * editor leaves behind; what documentation is written in; and the template
 * engines whose output is the real Dockerfile. `.orig` and `.rej` are the ones
 * that actually turn up — a conflicted merge leaves both beside the file.
 */
const DOCKERFILE_NOT_A_BUILD: ReadonlySet<string> = new Set([
  'orig', 'rej', 'bak', 'save', 'swp', 'tmp', 'patch', 'diff',
  'md', 'markdown', 'txt', 'rst', 'adoc',
  'template', 'tmpl', 'tpl', 'j2', 'jinja', 'jinja2', 'erb', 'mustache', 'hbs', 'in', 'gotmpl',
]);

/**
 * Whether a `Dockerfile.<profile>` is one of those.
 *
 * The last dotted segment, so `Dockerfile.dev.orig` — what a conflicted merge
 * leaves beside `Dockerfile.dev` — is refused on the `orig` rather than believed
 * on the `dev`.
 *
 * Only the `Dockerfile.<profile>` spelling is tested. In the other convention
 * the word before the dot is a name the author chose, and a stage genuinely
 * called `template` would be refused for a word that means nothing there.
 */
function rendersLater(file: string): boolean {
  const profile = /^[Dd]ockerfile\.(.+)$/.exec(file)?.[1];
  return profile !== undefined && DOCKERFILE_NOT_A_BUILD.has(profile.slice(profile.lastIndexOf('.') + 1).toLowerCase());
}

/**
 * The globs that find the profile-named Dockerfiles above. The two bare names
 * are in `MANIFEST_KINDS` and need none.
 *
 * `*.[Dd]ockerfile` is not narrowed any further on purpose: nothing else in a
 * repository ends in that word, where `Dockerfile.*` needs no defending either
 * — `manifestKind` turns away whatever these over-match.
 */
const DOCKERFILE_GLOBS: ReadonlyArray<string> = [
  'Dockerfile.*',
  'dockerfile.*',
  '*.Dockerfile',
  '*.dockerfile',
];

/**
 * The kind of manifest a path is, by its file name alone. The exact table first,
 * then the one convention that cannot be spelled out as a list of names.
 */
function manifestKind(uri: vscode.Uri): SourceKind | undefined {
  const name = path.posix.basename(uri.path);
  if (Object.prototype.hasOwnProperty.call(MANIFEST_KINDS, name)) {
    return MANIFEST_KINDS[name];
  }
  if (COMPOSE_NAME.test(name) && !COMPOSE_OVERRIDE_NAME.test(name)) {
    return 'docker-compose';
  }
  if (DOCKERFILE_NAME.test(name)) {
    return rendersLater(name) ? undefined : 'dockerfile';
  }
  return undefined;
}

/** The directory a manifest sits in, which is also the directory its tasks run in. */
function directoryOf(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: path.posix.dirname(uri.path) });
}

/**
 * The scan glob, built from the enabled ecosystems only. `MAX_MANIFESTS` is a
 * budget, and a repository full of Makefiles must not spend it once `make` is
 * taken out of `sources` — which is exactly the remedy the truncation warning
 * and the README offer.
 */
function manifestGlob(enabled: ReadonlySet<Ecosystem>): string | undefined {
  const names = Object.keys(MANIFEST_KINDS).filter((name) => enabled.has(ECOSYSTEM_OF[MANIFEST_KINDS[name]]));
  // Compose is the one kind whose files are not a fixed list of names; see
  // `COMPOSE_GLOBS`. What those globs over-match, `manifestKind` turns away.
  const patterns = enabled.has('docker') ? [...COMPOSE_GLOBS, ...DOCKERFILE_GLOBS] : [];
  const all = [...names, ...patterns];
  return all.length > 0 ? `**/{${all.join(',')}}` : undefined;
}

export const DEFAULT_EXCLUDE =
  '**/{node_modules,.git,dist,out,build,.next,coverage,target,vendor,__pycache__,.venv,venv,.tox,.nox,.mypy_cache,.pytest_cache}/**';

/** The words each Node runner puts in front of a script's name. */
const RUNNERS: Record<PackageManager, string[]> = {
  npm: ['npm', 'run'],
  yarn: ['yarn', 'run'],
  pnpm: ['pnpm', 'run'],
  bun: ['bun', 'run'],
  deno: ['deno', 'task'],
};

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno';

/** The runners a `packageManager` setting is allowed to name. */
const PACKAGE_MANAGERS = Object.keys(RUNNERS) as PackageManager[];

/**
 * A lookup that cannot answer with something off `Object.prototype`. The keys
 * here come from settings — `cargoCommands`, `goCommands` — and a plain
 * `table[key]` would hand back a function for `constructor` or `toString`.
 */
function known<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** A setting value split into argv words, so `build --release` is two arguments and not one. */
function words(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

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

/** Order in which the `packageManager` and `engines` fields are matched. */
const ENGINE_KEYS: ReadonlyArray<PackageManager> = ['deno', 'bun', 'pnpm', 'yarn', 'npm'];

/** The tool a `[project.scripts]` entry has to be run through, and the lock file that names it. */
type PythonRunner = 'uv' | 'poetry' | 'pdm' | 'rye' | 'pipenv' | 'hatch';

/** The runners a `pythonRunner` setting is allowed to name. */
const PYTHON_RUNNERS: ReadonlyArray<PythonRunner> = ['uv', 'poetry', 'pdm', 'rye', 'pipenv', 'hatch'];

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
    // The compose override files, which are read as part of the manifest beside
    // them rather than being one: whether one exists decides whether the rows
    // carry a second `-f`, so it has to be watched like the manifest itself.
    // And the profile-named compose files, which no list of names can hold.
    ...COMPOSE_OVERRIDE_FILES,
    ...COMPOSE_GLOBS,
    // The profile-named Dockerfiles, which are the same case: no list of names
    // holds `Dockerfile.dev` and `dev.Dockerfile`.
    ...DOCKERFILE_GLOBS,
    ...DETECTION_FILES.map(([file]) => file),
    ...PYTHON_LOCKS.map(([file]) => file),
  ]),
].join(',')}}`;

/**
 * Files whose mere existence adds or removes a row, rather than describing one.
 *
 * Some rows are not written down anywhere: cargo's `run` exists because the
 * crate has a `src/main.rs`, one `run: <name>` per file or directory under
 * `src/bin`, and one `example: <name>` per entry under `examples`. None of that
 * is in a manifest, so a manifest watcher never hears about it, and the list
 * stayed a Refresh behind the crate — a library that has just gained a
 * `main.rs` has a `run` to offer.
 *
 * The patterns match exactly what the parsers read: the direct entries of those
 * two directories, plus the `main.rs` inside one, which is how an entry that is
 * a directory is usually made. A file added deeper inside an example changes
 * nothing about the list, and does not appear here.
 *
 * Watched for creation and deletion only. What is in these files is the
 * compiler's business; only whether they are there is ours. Go is the one
 * exception and has a glob of its own — see `GO_GLOB`.
 */
export const SOURCE_GLOB =
  '**/{src/main.rs,src/bin/*,src/bin/*/main.rs,examples/*,examples/*/main.rs}';

/**
 * Go source files, which are the one case where what is *inside* the file
 * decides a row: a module root offers `run` when its applicable root `.go`
 * files form `package main` and declare `func main()`, whatever those files are
 * called. Editing either declaration creates and deletes nothing, so unlike
 * `SOURCE_GLOB` this one is watched for changes as well.
 *
 * Deliberately wider than what the scan reads — only the files beside a `go.mod`
 * matter, and no glob can say "beside a `go.mod`". The handler narrows it, so a
 * save anywhere else in a Go repository costs one `stat` rather than a rescan.
 */
export const GO_GLOB = '**/*.go';

/**
 * The extensions a shell row can be written with: the Bourne family, and the
 * three Windows writes its scripts in.
 *
 * Which of them a file carries decides two things — the words it is run through
 * (`shellRunners`) and the glyph its row wears — and nothing else: a `.ps1` is a
 * row exactly as a `.sh` is.
 *
 * `.psm1` is not here and is not an oversight: a PowerShell *module* is a library
 * to import, not a script to run, and a row that starts one would do nothing at
 * all.
 */
export const SHELL_EXTENSIONS: ReadonlyArray<string> = [
  'sh',
  'bash',
  'zsh',
  'ksh',
  'ps1',
  'bat',
  'cmd',
];

/**
 * What the shell watcher listens to. Every shell script in the workspace, and not
 * the `shellScripts` patterns the scan actually uses: the watchers are built once
 * in `activate` and never rebuilt, so a glob compiled from a setting would go
 * stale the moment that setting changed. Over-hearing costs a debounced rescan
 * that finds nothing; under-hearing costs a row that never appears.
 *
 * Changes count here, unlike `SOURCE_GLOB`: the file being there is the row, and
 * the comment line inside it is the row's dimmed text, which an edit has to reach.
 */
export const SHELL_GLOB = `**/*.{${SHELL_EXTENSIONS.join(',')}}`;

export interface ScriptEntry {
  /** Stable identity of a task: its manifest plus the task name. */
  key: string;
  /** Task name as written in the manifest. */
  name: string;
  /** What the task does, shown as dimmed text: the raw command, or its description. */
  command: string;
  /**
   * The file the task came from — for the shell rows, the directory the group
   * stands for, since there the group is a folder of scripts and no one file
   * declares them. Its identity, its heading and its storage ref are all read
   * off this, so it is a URI either way and `file` carries the real one.
   */
  manifest: vscode.Uri;
  /**
   * The file this row opens, when that is not the manifest itself. Only the
   * shell rows set it: their `manifest` is the directory they are grouped by,
   * and the script is what "go to definition" has to reach.
   */
  file?: vscode.Uri;
  /** What kind of file that is, which is what decides the parser and the runner. */
  kind: SourceKind;
  /**
   * The program and arguments to run. Left undefined for package.json scripts
   * alone, whose runner is resolved on demand — a lock file or a
   * `packageManager` field can change it without the script itself changing.
   *
   * A vector and not a command line because a task name comes out of a manifest
   * and ends up in a shell; see `launchArgv`.
   */
  argv?: string[];
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
  /** Undefined only for package.json, see `ScriptEntry.argv`. */
  argv?: string[];
}

interface ParsedManifest {
  packageName?: string;
  tasks: RawTask[];
  /** package.json fields that runner detection reads, kept to avoid a second read. */
  hints?: NodeHints;
  /**
   * Whether a row of this name, missing from this scan, may be a setting's doing
   * rather than the file's — a `*Commands` entry taken out, `pythonRunner` set
   * to `none`, a `.go` file beside the go.mod edited. Such a row comes back with
   * the setting, so this is what keeps `pruneStaleRefs` from reading its absence
   * as a deletion. Asked per name, because the rows a file declares on its own —
   * a compose service, a Dockerfile stage — are still gone when the file drops
   * them. Absent for a manifest whose rows are all its own text.
   */
  shaped?: (name: string) => boolean;
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
/**
 * Ceiling on shell scripts read in one scan, budgeted apart from the manifests
 * above. A repository that keeps three hundred `.sh` files around must not spend
 * the manifest budget on them — the truncation warning tells the user to trim
 * `sources`, and for a shell overflow that advice would be aimed at the wrong
 * setting. Narrowing `shellScripts` is the remedy here.
 */
const MAX_SHELL_SCRIPTS = 200;
/** How many files a scan reads at once. */
const SCAN_CONCURRENCY = 8;
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
 * The manifests the last scan read and understood but found no task in — a
 * package.json emptied down to `"scripts": {}`, a Makefile with nothing but
 * variables. They produce no `ScriptEntry`, so nothing else in the list says
 * they were seen at all, and "the file declares nothing" is indistinguishable
 * from "the file was not scanned" without them. `pruneStaleRefs` is the caller
 * that needs to tell the two apart.
 */
interface ScanFacts {
  empty: vscode.Uri[];
  /** The manifests whose rows a setting helps decide; see `ParsedManifest.shaped`. */
  shaped: Array<[vscode.Uri, (name: string) => boolean]>;
}

/**
 * What each scan learnt beyond its rows, filed under the very list it returned.
 *
 * Not module state, because a scan outlives a `resetSources`: one that was
 * already walking when a setting changed still hands its rows to whoever asked,
 * and the prune that runs on them has to read *that* scan's facts. An empty list
 * in their place would read every Cargo.toml as a file whose rows are all its
 * own, and throw away the star on the row the setting just hid.
 */
const scanFacts = new WeakMap<ReadonlyArray<ScriptEntry>, ScanFacts>();

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

/** The manifests of this scan that parsed cleanly and declared no tasks. */
export function emptyManifests(scripts: ReadonlyArray<ScriptEntry>): ReadonlyArray<vscode.Uri> {
  return scanFacts.get(scripts)?.empty ?? [];
}

/**
 * The manifests of this scan whose rows do not follow from the file alone, each
 * with the test for which of its row names a setting may have taken away.
 */
export function settingShapedManifests(
  scripts: ReadonlyArray<ScriptEntry>,
): ReadonlyArray<[vscode.Uri, (name: string) => boolean]> {
  return scanFacts.get(scripts)?.shaped ?? [];
}

/**
 * `work` over every item, at most `limit` at a time, with each answer at its
 * item's index — the order the items came in, not the order they finished.
 */
async function inBatches<T, R>(items: ReadonlyArray<T>, limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await work(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
  // A non-string (an array, the natural slip since every neighbour is one)
  // would take the whole scan down inside `findFiles` with nothing naming the
  // setting; fall back to the default rather than fail.
  const configuredExclude = setting<unknown>('exclude');
  const exclude = typeof configuredExclude === 'string' && configuredExclude ? configuredExclude : DEFAULT_EXCLUDE;
  const enabled = enabledEcosystems();
  const glob = manifestGlob(enabled);
  const manifests = glob ? await vscode.workspace.findFiles(glob, exclude, MAX_MANIFESTS) : [];

  // Hitting the cap means the list on screen is incomplete, which is worth
  // saying out loud — once per window, not on every rescan.
  if (manifests.length === MAX_MANIFESTS && !warnedAboutTruncation) {
    warnedAboutTruncation = true;
    void vscode.window.showWarningMessage(
      `Task & Script Explorer stopped after ${MAX_MANIFESTS} manifests, so some tasks are missing. ` +
        'Widen "taskRunnerUltimate.exclude" or trim "taskRunnerUltimate.sources" to skip the ones you do not need.',
    );
  }

  manifests.sort((a, b) => a.fsPath.length - b.fsPath.length || a.fsPath.localeCompare(b.fsPath));

  const entries: ScriptEntry[] = [];
  const blank: vscode.Uri[] = [];
  const shaped: ScanFacts['shaped'] = [];

  // Read and parsed a few at a time and then walked in the sorted order, so the
  // list comes out the same as a one-by-one pass would build it. Over Remote SSH
  // or in a container every stat and read is a round trip, and two thousand of
  // them in a row is what the first paint of the tree used to wait for.
  const results = await inBatches(manifests, SCAN_CONCURRENCY, async (manifest) => {
    const kind = manifestKind(manifest);
    if (!kind || !enabled.has(ECOSYSTEM_OF[kind])) {
      return undefined;
    }
    const cwd = directoryOf(manifest);
    const parsed = await parseManifest(manifest, kind, cwd);
    return parsed && { kind, cwd, parsed };
  });

  for (const [at, manifest] of manifests.entries()) {
    const result = results[at];
    if (!result) {
      continue;
    }
    const { kind, cwd, parsed } = result;
    if (parsed.shaped) {
      shaped.push([manifest, parsed.shaped]);
    }
    if (parsed.tasks.length === 0) {
      blank.push(manifest);
      continue;
    }
    // Only while this scan is still the current one: a `resetSources` during the
    // parse has cleared the map for a fresher scan, and repopulating it here
    // would hand that scan hints read before the change it is rescanning for.
    if (parsed.hints && started === generation) {
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
        argv: task.argv,
        manifest,
        kind,
        cwd,
        location,
        directory,
        packageName: parsed.packageName,
      });
    }
  }

  // Shell scripts are matched by pattern rather than by file name, so they do
  // not go through `MANIFEST_KINDS` and get a pass — and a budget — of their own.
  if (enabled.has('shell')) {
    entries.push(...(await collectShellScripts(exclude)));
  }

  if (started === generation) {
    await detectPackageManagers(entries, started);
  }
  // Published only once the runners are known. A caller that reached the cache
  // while the detection walk was still going would find every Node package
  // undetected, fall back to `npm`, and launch a pnpm workspace's scripts with
  // the wrong runner. Nobody waits any longer for it: `runScan` already awaited
  // detection before returning, so every caller queued on `scanning` did too.
  //
  // The generation is checked again after the await for the same reason it is
  // checked inside the walk — a `resetSources` in the meantime means these
  // entries describe manifests that have already changed.
  if (started === generation) {
    cache = entries;
  }
  scanFacts.set(entries, { empty: blank, shaped });
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

/** Exported for the shell watcher, which has to answer for `sources` with the scan's own rule. */
export function enabledEcosystems(): Set<Ecosystem> {
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

  /**
   * The file this row's tasks come from, for the runners that would otherwise
   * go looking for one themselves.
   *
   * Always, and not only where the scan saw a second candidate beside it: what
   * the scan sees is not what the runner sees. A GNUmakefile left out by
   * `exclude`, or dropped when the manifest budget ran out, is still on disk and
   * still the file `make` prefers — so a row from the Makefile would have run
   * the other file's target of the same name. The command a row shows is the
   * command it runs, and it names its own file to stay that way.
   */
  const file = path.posix.basename(uri.path);

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
      return parseMakefile(text, file);
    case 'just':
      return parseJustfile(text, file);
    case 'taskfile':
      return parseTaskfile(text, file);
    case 'go':
      return parseGoMod(text, cwd);
    case 'mise':
      return parseMise(text);
    case 'docker-compose':
      return parseCompose(text, file, cwd);
    case 'dockerfile':
      return parseDockerfile(text, file, cwd);
    // `shell` never reaches here: its rows are built by `collectShellScripts`,
    // from files no `MANIFEST_KINDS` entry names.
    default:
      return undefined;
  }
}

// --- Node, Deno and PHP ------------------------------------------------------

function parsePackageJson(text: string): ParsedManifest | undefined {
  const json = parseJsonc(text) as Record<string, unknown> | undefined;
  const scripts = json?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return undefined;
  }
  const tasks: RawTask[] = [];
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    const command = commandOf(value);
    if (command !== undefined) {
      // No `argv`: the runner is resolved per package, on demand.
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
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    return undefined;
  }
  const out: RawTask[] = [];
  for (const [name, value] of Object.entries(tasks as Record<string, unknown>)) {
    const command = commandOf(value);
    if (command !== undefined) {
      out.push({ name, command });
      continue;
    }
    // Deno ≥ 2.1 lets a task be nothing but `dependencies` (or a `description`):
    // `deno task <name>` is still valid, so the row stays.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const meta = value as { description?: unknown; dependencies?: unknown };
      const description = typeof meta.description === 'string' ? meta.description : undefined;
      const deps = Array.isArray(meta.dependencies) ? meta.dependencies.filter((d): d is string => typeof d === 'string') : [];
      out.push({ name, command: description ?? (deps.length > 0 ? deps.join(', ') : `deno task ${name}`) });
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
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
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
      argv: ['composer', 'run-script', name],
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

const CARGO_COMMANDS: Record<string, string[]> = {
  build: ['cargo', 'build'],
  test: ['cargo', 'test'],
  check: ['cargo', 'check'],
  clippy: ['cargo', 'clippy', '--all-targets'],
  fmt: ['cargo', 'fmt'],
  bench: ['cargo', 'bench'],
  doc: ['cargo', 'doc', '--open'],
  clean: ['cargo', 'clean'],
  update: ['cargo', 'update'],
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
  // For cargo the command shown and the command run are the same thing, so the
  // row is written once, as the vector, and read back for the label. A binary or
  // an example name is the crate's text and stays one argument of its own.
  const push = (name: string, argv: string[]) =>
    tasks.push({ name, command: argv.join(' '), argv });

  const runs = commands.includes('run');
  if (runs && pkg) {
    // A crate with no binary cannot be run at all, and one with several needs to
    // be told which — so a bare `run` row is only correct for a single binary.
    const bins = await cargoBins(toml, cwd, packageName);
    if (bins.length === 1) {
      push('run', ['cargo', 'run']);
    } else {
      for (const bin of bins) {
        push(`run: ${bin}`, ['cargo', 'run', '--bin', bin]);
      }
    }
    for (const example of await cargoExamples(toml, cwd)) {
      push(`example: ${example}`, ['cargo', 'run', '--example', example]);
    }
  }

  for (const command of commands) {
    if (command === 'run') {
      continue;
    }
    // A command of the user's own may carry flags — `build --release` — so it
    // is split into words rather than quoted as one.
    push(command, known(CARGO_COMMANDS, command) ?? ['cargo', ...words(command)]);
  }

  // No rows at all is a setting's doing (`cargoCommands: []`, or `["run"]` on a
  // library), not the manifest's — reporting it as an empty manifest would let
  // the prune throw the crate's stars and colours away.
  // Every name but the targets is a `cargoCommands` entry. The targets are the
  // crate's own — a binary deleted is gone — unless `run` is what was taken out.
  const target = (name: string) => name === 'run' || name.startsWith('run: ') || name.startsWith('example: ');
  const shaped = (name: string) => !runs || !target(name);
  return tasks.length > 0 ? { packageName, tasks, shaped } : undefined;
}

/**
 * Whether cargo discovers targets of this kind on its own, or only runs what the
 * manifest declares. `autobins` / `autoexamples` in `[package]` are what turn the
 * walk off; anything that is not an explicit `false` leaves it on, which is the
 * default and what nearly every crate has.
 */
function autoDiscovers(toml: Record<string, unknown>, key: 'autobins' | 'autoexamples'): boolean {
  return tomlTable(toml, 'package')?.[key] !== false;
}

/**
 * A directory under `src/bin` or `examples` is a target only if it holds a
 * `main.rs` — that file is the target, and the directory is the crate's way of
 * giving it modules of its own. A folder of shared helpers beside the binaries is
 * the same shape without the `main.rs`, and cargo does not run it either.
 */
async function isDirectoryTarget(parent: vscode.Uri, name: string): Promise<boolean> {
  return exists(vscode.Uri.joinPath(parent, name, 'main.rs'));
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

  const declared = tomlTables(toml, 'bin');
  // A `[[bin]]` that points at `src/main.rs` is that file's target, named — so
  // the implicit one is not there to be found any more. Adding it anyway invents
  // a `--bin <package>` cargo answers with "no bin target named ...".
  const claimsMain = declared.some(
    (bin) => typeof bin.path === 'string' && bin.path.replace(/\\/g, '/').replace(/^\.\//, '') === 'src/main.rs',
  );
  const auto = autoDiscovers(toml, 'autobins');

  // `src/main.rs` first: it is the crate's own program, and the one anyone
  // reaching for "run" means. Cargo finds it whether or not `[[bin]]` sections
  // are present, so the two lists are additive rather than exclusive.
  if (auto && !claimsMain && packageName && (await exists(vscode.Uri.joinPath(cwd, 'src', 'main.rs')))) {
    add(packageName);
  }
  for (const bin of declared) {
    if (typeof bin.name === 'string') {
      add(bin.name);
    }
  }
  if (!auto) {
    return bins;
  }
  const dir = vscode.Uri.joinPath(cwd, 'src', 'bin');
  for (const [name, type] of await listDirectory(dir)) {
    if (type === vscode.FileType.File && name.endsWith('.rs')) {
      add(name.slice(0, -3));
    } else if (type === vscode.FileType.Directory && (await isDirectoryTarget(dir, name))) {
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
  if (!autoDiscovers(toml, 'autoexamples')) {
    return examples;
  }
  const dir = vscode.Uri.joinPath(cwd, 'examples');
  for (const [name, type] of await listDirectory(dir)) {
    if (type === vscode.FileType.File && name.endsWith('.rs')) {
      add(name.slice(0, -3));
    } else if (type === vscode.FileType.Directory && (await isDirectoryTarget(dir, name))) {
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
      argv: ['cargo', 'make', name],
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
  const add = (name: string, value: unknown, argv: string[], fallback: string) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    tasks.push({ name, command: describe(value) ?? fallback, argv });
  };

  // Each of these tables names its own runner, so nothing has to be detected:
  // a task under [tool.pdm.scripts] is a pdm task wherever it lives.
  for (const [name, value] of tableEntries(toml, 'tool', 'poetry', 'scripts')) {
    add(name, value, ['poetry', 'run', name], `poetry run ${name}`);
  }
  for (const [name, value] of tableEntries(toml, 'tool', 'pdm', 'scripts')) {
    // `_` holds options shared by every script rather than a script of its own.
    if (name !== '_') {
      add(name, value, ['pdm', 'run', name], `pdm run ${name}`);
    }
  }
  for (const [name, value] of tableEntries(toml, 'tool', 'rye', 'scripts')) {
    add(name, value, ['rye', 'run', name], `rye run ${name}`);
  }

  // poethepoet is normally installed into the project's own environment, so it
  // is reached through poetry when the project uses poetry.
  const poe = tomlTable(toml, 'tool', 'poetry') ? ['poetry', 'run', 'poe'] : ['poe'];
  for (const [name, value] of tableEntries(toml, 'tool', 'poe', 'tasks')) {
    add(name, value, [...poe, name], `${poe.join(' ')} ${name}`);
  }

  // Hatch keeps one script table per environment; the default one is addressed
  // without a prefix, the rest as `env:script`.
  const envs = tomlTable(toml, 'tool', 'hatch', 'envs');
  for (const env of Object.keys(envs ?? {})) {
    for (const [name, value] of tableEntries(toml, 'tool', 'hatch', 'envs', env, 'scripts')) {
      const target = env === 'default' ? name : `${env}:${name}`;
      add(target, value, ['hatch', 'run', target], `hatch run ${target}`);
    }
  }

  // [project.scripts] is a list of console entry points rather than tasks: they
  // only exist inside the project's environment, so they are listed only when
  // something is known to be able to enter it.
  const runner = await pythonRunner(toml, cwd);
  const entryPoints = tableEntries(toml, 'project', 'scripts');
  if (runner) {
    for (const [name, value] of entryPoints) {
      add(name, value, [runner, 'run', name], `${runner} run ${name}`);
    }
  }

  const project = tomlTable(toml, 'project');
  const poetry = tomlTable(toml, 'tool', 'poetry');
  const packageName =
    (typeof project?.name === 'string' ? project.name : undefined) ??
    (typeof poetry?.name === 'string' ? poetry.name : undefined);

  // As with Cargo: `pythonRunner: "none"` leaving no rows is not a manifest
  // that declares nothing, and must not read as one to the prune.
  // The entry points come and go with `pythonRunner` and the lock files, so one
  // the file still declares proves nothing by its absence. One it no longer
  // declares, and every task table's row, is gone with the file's say-so.
  const declared = new Set(entryPoints.map(([name]) => name));
  return tasks.length > 0
    ? { tasks, packageName, shaped: declared.size > 0 ? (name: string) => declared.has(name) : undefined }
    : undefined;
}

async function pythonRunner(
  toml: Record<string, unknown>,
  cwd: vscode.Uri,
): Promise<PythonRunner | undefined> {
  const configured = setting<string>('pythonRunner');
  if (configured === 'none') {
    return undefined;
  }
  // Matched against the known runners rather than trusted, the same way
  // `resolvePackageManager` matches its own: this string becomes `argv[0]`, and a
  // settings.json — a workspace's `.vscode/settings.json` included — can hold
  // anything at all. Anything unrecognised, 'auto' included, falls through to
  // detection.
  const chosen = PYTHON_RUNNERS.find((runner) => runner === configured);
  if (chosen) {
    return chosen;
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
      argv: ['pipenv', 'run', name],
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
    // Generative names — `py{38,39}-django{42}` — stand for a matrix rather than
    // an environment, and expanding one here would invent environments that the
    // file never names. tox does not expand them after `-e` either, so a row
    // named that way could only fail. Both braces are checked because the split
    // of `envlist` below lands in the middle of one, and the same rule covers a
    // `[testenv:{lint,format}]` section header.
    if (name && !/[{}]/.test(name) && !names.includes(name)) {
      names.push(name);
    }
  };

  const tox = sections.find((section) => section.name === 'tox');
  const list = tox?.options.get('envlist') ?? tox?.options.get('env_list') ?? '';
  for (const entry of list.split(/[,\n]/)) {
    add(entry.trim());
  }
  // A section header is different: `[testenv:{lint,format}]` is tox declaring
  // the environments `lint` and `format`, both of which `tox -e` accepts. So the
  // header is opened into the names it stands for, and each keeps the section it
  // came from for its description.
  const sectionOf = new Map<string, IniSection>();
  for (const section of sections) {
    if (!section.name.startsWith('testenv:')) {
      continue;
    }
    for (const expanded of expandBraces(section.name.slice('testenv:'.length))) {
      const name = expanded.replace(/\s+/g, '');
      if (!sectionOf.has(name)) {
        sectionOf.set(name, section);
      }
      add(name);
    }
  }

  return {
    tasks: names.map((name) => {
      const description = sectionOf.get(name)?.options.get('description');
      return {
        name,
        command: description || `tox -e ${name}`,
        argv: ['tox', '-e', name],
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
        tasks.push({ name, command: `nox -s ${name}`, argv: ['nox', '-s', name] });
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
// `(?![:=])` after the colon(s) keeps `FOO ::= x` and `FOO :::= x` — immediate
// assignments — from reading as a rule for `FOO`.
export const MAKE_TARGET = /^([^\s:#=][^:=#]*?)\s*::?(?![:=])\s*(.*)$/;
/** `build: deps ## Build everything` — the convention every self-documenting Makefile uses. */
const MAKE_DOC = /##\s*(.*)$/;
/**
 * `define` as make reads it: the directive, perhaps behind `override`, `export`
 * or `private`, and then a space or the end of the line. `define-docs:` is a rule.
 */
const MAKE_DEFINE = /^(?:(?:override|export|private)\s+)*define(?:\s|$)/;
const MAKE_ENDEF = /^endef(?:\s|#|$)/;

/**
 * Which lines belong to a `define … endef` block, the directives included.
 *
 * Inside one a line is text, not a rule — the self-documenting `define HELP` /
 * `Usage: make <target>` idiom would otherwise list `Usage`. Exported so that
 * `locate.ts` skips exactly what the parser skipped: a help text reading
 * `build: Build the project` is not the rule a row came from.
 */
export function makeDefineLines(lines: ReadonlyArray<string>): boolean[] {
  let defining = false;
  return lines.map((line) => {
    // A recipe line is the recipe's, whatever it says.
    if (line.startsWith('\t')) {
      return defining;
    }
    const trimmed = line.trim();
    if (defining) {
      defining = !MAKE_ENDEF.test(trimmed);
      return true;
    }
    defining = MAKE_DEFINE.test(trimmed);
    return defining;
  });
}

function parseMakefile(text: string, file: string): ParsedManifest | undefined {
  // make searches for GNUmakefile, then makefile, then Makefile, and this row
  // belongs to one of them; see `parseManifest` for why the choice is never
  // left to it.
  const runner = ['make', '-f', file];
  const tasks: RawTask[] = [];
  const seen = new Set<string>();
  let doc = '';
  const lines = text.split(/\r?\n/);
  const defined = makeDefineLines(lines);

  for (const [index, line] of lines.entries()) {
    // A tab starts a recipe body, which can hold anything at all.
    if (line.startsWith('\t')) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || defined[index]) {
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
      // `&` is the grouped-target marker of make 4.3 (`a b &: c`), not a name.
      if (!name || name.startsWith('.') || name.startsWith('-') || /[%$()&]/.test(name) || seen.has(name)) {
        continue;
      }
      seen.add(name);
      tasks.push({
        name,
        command: description || `make ${name}`,
        argv: [...runner, name],
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

function parseJustfile(text: string, file: string): ParsedManifest | undefined {
  // just, handed a justfile, takes its parent as the working directory — which
  // is the directory the task runs in anyway. Left to search, it refuses to run
  // at all where a second candidate sits beside this one.
  const runner = ['just', '--justfile', file];
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
      // `[private]` on its own, or one of several: `[private, no-cd]`.
      priv = priv || /\[(?:[^\]]*,)?\s*private\s*(?:,[^\]]*)?\]/.test(line);
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
      argv: [...runner, name],
    });
  }

  return tasks.length > 0 ? { tasks } : undefined;
}

// --- Taskfile (go-task) ------------------------------------------------------

/**
 * The keys one level under a named top-level block, each with the lines of its
 * body — found by indentation rather than by parsing YAML, which would mean
 * bundling a parser to read a list of keys.
 *
 * Shared by go-task's `tasks:` and compose's `services:`, which want exactly the
 * same thing from a file of the same shape. What it does not do is what neither
 * of them needs: an anchor merged into a body hides that body (the names still
 * come out right), a second document in the same file runs its keys together,
 * and flow style is not read at all.
 *
 * Exported so `locate.ts` can find a key with the rule that put it in the list.
 */
export function yamlBlockKeys(
  lines: ReadonlyArray<string>,
  block: string,
): Array<{ name: string; body: string[]; raw: string[]; line: number }> {
  const header = new RegExp(`^${block}:\\s*(#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) {
    return [];
  }

  const entries: Array<{ name: string; body: string[]; raw: string[]; line: number }> = [];
  let indent: number | undefined;
  let current: { name: string; body: string[]; raw: string[]; line: number } | undefined;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
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
      current?.raw.push(line);
      continue;
    }
    // A YAML key ends at the last colon that is followed by a space or the end
    // of the line, which is what keeps namespaced names like `docker:build`.
    const key = /^(.*?):(\s|$)/.exec(line.trim());
    if (!key) {
      continue;
    }
    current = { name: key[1].trim().replace(/^["']|["']$/g, ''), body: [], raw: [], line: index };
    entries.push(current);
  }

  return entries;
}

function parseTaskfile(text: string, file: string): ParsedManifest | undefined {
  // task has its own order for Taskfile.yml, Taskfile.yaml and the dist
  // variants, and would otherwise open whichever of them it prefers.
  const runner = ['task', '--taskfile', file];
  const block = yamlBlockKeys(text.split(/\r?\n/), 'tasks');

  const tasks: RawTask[] = [];
  for (const entry of block) {
    if (!entry.name || entry.body.some((line) => /^internal:\s*true\b/.test(line))) {
      continue;
    }
    // `desc` first: it is the one line `task --list` prints, where `summary` is
    // the long form behind `task --summary`.
    const description = taskfileText(entry.raw, 'desc') || taskfileText(entry.raw, 'summary');
    tasks.push({
      name: entry.name,
      command: description || `task ${entry.name}`,
      argv: [...runner, entry.name],
    });
  }

  return tasks.length > 0 ? { tasks } : undefined;
}

/**
 * The text of one of a task's own string keys — at the task's own depth, so a
 * `desc:` inside a `vars:` or a `requires:` list is not taken for the task's.
 *
 * A block scalar — `summary: |`, the form go-task's own documentation uses —
 * puts nothing after the colon but its indicator, so the first line of the
 * block is read instead: the row shows one line either way. Only a line deeper
 * than the key belongs to the block; an empty block followed by `cmds:` has no
 * first line, and says nothing.
 */
function taskfileText(raw: ReadonlyArray<string>, key: string): string | undefined {
  const depth = (line: string) => line.length - line.trimStart().length;
  const own = raw.length > 0 ? Math.min(...raw.map(depth)) : 0;
  const at = raw.findIndex((line) => depth(line) === own && line.trimStart().startsWith(`${key}:`));
  if (at < 0) {
    return undefined;
  }
  let value = raw[at].trim().slice(key.length + 1).trim();
  if (/^[|>][+-]?\d*[+-]?\s*(#.*)?$/.test(value)) {
    const next = raw[at + 1];
    value = next !== undefined && depth(next) > own ? next : '';
  }
  return value.trim().replace(/^["']|["']$/g, '') || undefined;
}

// --- Go ----------------------------------------------------------------------

const DEFAULT_GO_COMMANDS: ReadonlyArray<string> = ['run', 'build', 'test', 'vet'];

const GO_COMMANDS: Record<string, string[]> = {
  run: ['go', 'run', '.'],
  build: ['go', 'build', './...'],
  test: ['go', 'test', './...'],
  vet: ['go', 'vet', './...'],
  fmt: ['go', 'fmt', './...'],
  tidy: ['go', 'mod', 'tidy'],
  generate: ['go', 'generate', './...'],
  bench: ['go', 'test', '-bench=.', './...'],
};

async function parseGoMod(text: string, cwd: vscode.Uri): Promise<ParsedManifest | undefined> {
  const module = /^module\s+(\S+)/m.exec(text);
  // The `go 1.N` line is the oldest toolchain that can build the module, so it
  // is the one release every toolchain that gets to `go run .` has reached.
  const release = /^go\s+1\.(\d+)/m.exec(text);
  const hasMain = await goRootIsProgram(cwd, release ? Number(release[1]) : undefined);

  const tasks: RawTask[] = [];
  for (const command of settingList('goCommands', DEFAULT_GO_COMMANDS)) {
    // `go run .` only means something where the module root is itself a program.
    if (command === 'run' && !hasMain) {
      continue;
    }
    const argv = known(GO_COMMANDS, command) ?? ['go', ...words(command)];
    tasks.push({ name: command, command: argv.join(' '), argv });
  }

  // Every row is a `goCommands` entry, and `run` answers to the `.go` files too.
  return tasks.length > 0 ? { tasks, packageName: module?.[1], shaped: () => true } : undefined;
}

/**
 * Whether the module root is itself a program: `go run .` wants a `package main`
 * with a `func main()` in files selected for this platform. Go does not care what
 * those files are called — `server.go` or `cli.go` are as good as `main.go`.
 * `main.go` is checked first as the cheap common case; otherwise the root `.go`
 * files (tests excluded) are read for the package and entry-point declarations.
 */
async function goRootIsProgram(cwd: vscode.Uri, release: number | undefined): Promise<boolean> {
  const entries = await listDirectory(cwd);
  const sources = entries
    .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.go') && !name.endsWith('_test.go'))
    .map(([name]) => name)
    // Before the read rather than after it: a file for another platform is
    // settled by its name, and reading it would only spend the budget below.
    .filter(goFileNameApplies)
    // `main.go` first, and read like any other file rather than believed on its
    // name: a library may hold a `main.go` that says `package library`, and
    // `go run .` on that fails with "not a main package". Putting it first is
    // only so the usual program costs one read whatever order the file system
    // listed in.
    .sort((a, b) => Number(b === 'main.go') - Number(a === 'main.go'));

  // A budget in bytes rather than a count of files: what makes this expensive is
  // how much there is to read, and a cap on files would hide the clause behind
  // whatever the listing happened to put first. A root over the budget is read
  // as far as the budget goes and then called a library, which is the answer
  // that costs a missing row rather than a row that cannot run.
  let budget = MAX_GO_ROOT_BYTES;
  let mainPackage = false;
  let mainFunction = false;
  for (const name of sources) {
    if (budget <= 0) {
      break;
    }
    const text = await readText(vscode.Uri.joinPath(cwd, name));
    if (text === undefined) {
      continue;
    }
    budget -= text.length;
    if (!goBuildApplies(text, release)) {
      // `//go:build ignore` + `package main` is the `go generate` helper idiom;
      // it does not make a library a program. No test of its own for that: `ignore`
      // is a tag nothing sets, so the evaluator already says no to it — and says
      // yes to `ignore || darwin` on a Mac, which is what Go does too.
      continue;
    }
    const code = goCode(text);
    if (GO_PACKAGE_MAIN.test(code)) {
      mainPackage = true;
      mainFunction = mainFunction || GO_MAIN_FUNCTION.test(code);
    }
  }
  return mainPackage && mainFunction;
}

/** The package clause; `//go:build` lines and comments sit above it. */
const GO_PACKAGE_MAIN = /^package\s+main\s*$/m;
/** The exact entry point required by the Go specification. */
const GO_MAIN_FUNCTION = /^func\s+main\s*\(\s*\)\s*\{/m;
/** How much of a module root is read looking for its package clause. */
const MAX_GO_ROOT_BYTES = 256_000;

const CURRENT_GOOS = process.platform === 'win32' ? 'windows' : process.platform;
const CURRENT_GOARCH: string =
  ({ x64: 'amd64', ia32: '386' } as Record<string, string>)[process.arch] ?? process.arch;
const GO_OSES = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'illumos', 'ios', 'js', 'linux',
  'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows',
]);
const GO_ARCHES = new Set([
  '386', 'amd64', 'arm', 'arm64', 'loong64', 'mips', 'mips64', 'mips64le',
  'mipsle', 'ppc64', 'ppc64le', 'riscv64', 's390x', 'wasm',
]);
const GO_UNIX = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'illumos', 'ios', 'linux',
  'netbsd', 'openbsd', 'solaris',
]);

/**
 * Applies Go's platform suffix and ignored-file conventions without spawning Go.
 *
 * As `go/build` does it: whatever comes before the first `_` is the file's own
 * name and never a suffix, so `linux.go` and `windows.go` are built everywhere —
 * only `x_linux.go` is Linux's alone.
 */
function goFileNameApplies(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) {
    return false;
  }
  const stem = name.slice(0, -3);
  const at = stem.indexOf('_');
  if (at < 0) {
    return true;
  }
  const parts = stem.slice(at + 1).split('_');
  if (parts.at(-1) === 'test') {
    parts.pop();
  }
  const last = parts.at(-1) ?? '';
  const before = parts.at(-2) ?? '';
  if (GO_OSES.has(before) && GO_ARCHES.has(last)) {
    return before === CURRENT_GOOS && last === CURRENT_GOARCH;
  }
  if (GO_OSES.has(last)) {
    return last === CURRENT_GOOS;
  }
  return !GO_ARCHES.has(last) || last === CURRENT_GOARCH;
}

/** Applies modern and legacy build constraints using the host's standard tags. */
function goBuildApplies(text: string, release?: number): boolean {
  const term = (tag: string) => goBuildTerm(tag, release);
  const modern = /^\/\/go:build\s+(.+)$/m.exec(text)?.[1];
  if (modern !== undefined) {
    return goBuildExpression(modern, term);
  }
  const legacy = [...text.matchAll(/^\/\/\s*\+build\s+(.+)$/gm)].map((match) => match[1]);
  return legacy.every((line) =>
    line.trim().split(/\s+/).some((option) => option.split(',').every(term)),
  );
}

/**
 * One tag, as the host's own toolchain would set it — as far as that can be
 * known without running it. What cannot be known reads as unset, which is the
 * answer that costs a missing `run` row rather than one that fails.
 */
function goBuildTerm(term: string, release?: number): boolean {
  if (term.startsWith('!')) {
    return !goBuildTerm(term.slice(1), release);
  }
  // A toolchain sets every `go1.N` up to its own version. The installed one is
  // not known here, but the module's `go` line is a floor under it.
  const tag = /^go1\.(\d+)$/.exec(term);
  if (tag) {
    return release !== undefined && Number(tag[1]) <= release;
  }
  return (
    term === CURRENT_GOOS ||
    term === CURRENT_GOARCH ||
    term === 'gc' ||
    (term === 'unix' && GO_UNIX.has(CURRENT_GOOS))
    // `cgo` is not here: it is off under `CGO_ENABLED=0` and wherever no C
    // compiler is found, which a scan cannot tell apart from on.
  );
}

/** Recursive-descent evaluator for identifiers, !, &&, || and parentheses. */
function goBuildExpression(source: string, term: (tag: string) => boolean): boolean {
  const tokens = source.match(/[A-Za-z0-9_.]+|&&|\|\||[!()]/g) ?? [];
  let index = 0;
  const primary = (): boolean => {
    const token = tokens[index++];
    if (token === '!') {
      return !primary();
    }
    if (token === '(') {
      const value = disjunction();
      if (tokens[index] !== ')') {
        return false;
      }
      index++;
      return value;
    }
    return token !== undefined && term(token);
  };
  const conjunction = (): boolean => {
    let value = primary();
    while (tokens[index] === '&&') {
      index++;
      const right = primary();
      value = value && right;
    }
    return value;
  };
  const disjunction = (): boolean => {
    let value = conjunction();
    while (tokens[index] === '||') {
      index++;
      const right = conjunction();
      value = value || right;
    }
    return value;
  };
  const value = disjunction();
  return index === tokens.length && value;
}

/** Removes comments and literals so declarations written inside either cannot match. */
function goCode(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    const next = text[at + 1];
    if (char === '/' && next === '/') {
      while (at < text.length && text[at] !== '\n') {
        at++;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      at += 2;
      while (at < text.length && !(text[at] === '*' && text[at + 1] === '/')) {
        out += text[at] === '\n' ? '\n' : ' ';
        at++;
      }
      at += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += ' ';
      at++;
      while (at < text.length) {
        const inside = text[at++];
        if (inside === '\n') {
          out += '\n';
        }
        if (quote !== '`' && inside === '\\') {
          at++;
        } else if (inside === quote) {
          break;
        }
      }
      continue;
    }
    out += char;
    at++;
  }
  return out;
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
      argv: ['mise', 'run', name],
    });
  }
  return { tasks: out };
}

// --- Docker compose ----------------------------------------------------------

/**
 * Compose declares services, not tasks, so what a file offers is the subcommands
 * worth having on a list — the same shape cargo's rows take, and for the same
 * reason.
 *
 * `up` and `down` are not here. They are the compose item's two fixed buttons,
 * added by `parseCompose` whatever the setting says, and listing them as
 * defaults would invite somebody to take them out of a list that no longer
 * controls them.
 */
const DEFAULT_COMPOSE_COMMANDS: ReadonlyArray<string> = ['build', 'logs', 'ps'];

/**
 * The arguments each command name stands for, after the `docker compose -f
 * <file>` every row already carries. Anything not listed runs as itself.
 *
 * `logs` is the one that is not one-for-one: without `-f` it prints what has
 * happened and exits, and a row that ends the moment you click it is a row that
 * was never worth a spinner. `up` is deliberately not given `-d` for the
 * opposite reason — see `parseCompose`.
 */
/**
 * Whether an option makes a container command leave its containers behind.
 *
 * Shared by compose and the Dockerfile rows: a detached row exits the moment it
 * starts, so ■ has nothing to stop and the spinner lies. `--wait` is compose's
 * alone — `docker run` has no such flag — and costs nothing to test for.
 */
/** Short options of `docker run` and compose that take a value, which ends a bundle. */
const SHORT_VALUE_OPTIONS = new Set(['a', 'c', 'e', 'f', 'h', 'l', 'm', 'p', 'u', 'v', 'w']);

/**
 * A word with any request to detach taken out of it, or nothing when that was
 * all it said.
 *
 * A bundle of short options is how `docker run` is conventionally written:
 * `-dit` is in Docker's own documentation, and `-dT` is compose's `exec`. The
 * `d` inside one detaches exactly as a `-d` on its own would, so it is the `d`
 * that goes and the rest of the bundle that stays — `-dit` is still `-it`.
 * Only up to the first letter that takes a value, since the rest of the word is
 * that value: the `d` of `-edev` belongs to `dev`. A capital `D` is `--debug`
 * and stays; `--detach-keys=…` sets a key sequence rather than detaching, and
 * is not swept up either.
 */
function withoutDetach(word: string): string | undefined {
  if (word === '--detach' || word.startsWith('--detach=') || word === '--wait' || word.startsWith('--wait=')) {
    return undefined;
  }
  if (!/^-[A-Za-z]/.test(word) || word.startsWith('--')) {
    return word;
  }
  let out = '-';
  for (let at = 1; at < word.length; at++) {
    const letter = word[at];
    if (SHORT_VALUE_OPTIONS.has(letter)) {
      out += word.slice(at);
      break;
    }
    if (letter !== 'd') {
      out += letter;
    }
  }
  return out === '-' ? undefined : out;
}

/** `words`, with every request to detach taken out; see `withoutDetach`. */
function undetached(list: ReadonlyArray<string>): string[] {
  return list.flatMap((word) => withoutDetach(word) ?? []);
}

/** compose's own options that take their value as the next word, global ones included. */
const COMPOSE_VALUE_OPTIONS = new Set([
  '-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory',
  '--ansi', '--progress', '--parallel',
  '-e', '--env', '--env-from-file', '-l', '--label', '--name', '--publish', '-u', '--user',
  '-v', '--volume', '-w', '--workdir', '--entrypoint', '--cap-add', '--cap-drop', '--pull', '--index',
]);

/**
 * A compose command of the user's own, as words, minus any request to detach —
 * but only where compose itself reads it. `run` and `exec` stop taking options
 * at the service name, and everything after it is the command inside the
 * container: the `-d` of `exec web ls -d /tmp` is `ls`'s, and the `-vd` of
 * `run web pytest -vd` is pytest's. Every other subcommand takes its options
 * anywhere, so there a detach is dropped wherever it stands.
 */
function composeUserArgs(entry: string): string[] {
  const all = words(entry);
  const out: string[] = [];
  let index = 0;
  const option = () => {
    const word = withoutDetach(all[index++]);
    if (word === undefined) {
      return;
    }
    out.push(word);
    if (COMPOSE_VALUE_OPTIONS.has(word) && index < all.length) {
      out.push(all[index++]);
    }
  };
  while (index < all.length && all[index].startsWith('-')) {
    option();
  }
  const verb = all[index];
  if (verb === undefined) {
    return out;
  }
  out.push(verb);
  index++;
  if (verb !== 'run' && verb !== 'exec') {
    return [...out, ...undetached(all.slice(index))];
  }
  while (index < all.length && all[index].startsWith('-') && all[index] !== '--') {
    option();
  }
  return [...out, ...all.slice(index)];
}

const DOCKER_COMPOSE_COMMANDS: Record<string, string[]> = {
  up: ['up'],
  down: ['down'],
  build: ['build'],
  logs: ['logs', '-f'],
  ps: ['ps'],
  start: ['start'],
  stop: ['stop'],
  restart: ['restart'],
  pull: ['pull'],
  config: ['config'],
};

/**
 * How compose is invoked here: the v2 plugin by default, since the standalone
 * v1 binary has been end-of-life since July 2023.
 *
 * A two-value setting and no `auto`, unlike `pythonRunner`: there the choice is
 * decided by a lock file the scan can read, and the only honest detection for
 * this one is running `docker compose version` — and a scan never spawns a
 * process. Spelled as the command and split on whitespace, so what is in
 * settings.json is what ends up in the terminal.
 */
function composeProgram(): string[] {
  const configured = setting<string>('dockerCompose');
  const value = (typeof configured === 'string' ? configured : '').trim();
  return (value || 'docker compose').split(/\s+/);
}

/**
 * The rows for one compose file.
 *
 * `-f <basename>` for the reason make, just and go-task all name their own file:
 * what the scan saw is not what the runner would pick, and compose has its own
 * precedence across four spellings. The catch is that passing `-f` turns off the
 * automatic merge of the override file, which is a live development workflow —
 * so it is looked for and appended as a second `-f`, which is exactly what the
 * merge would have done.
 *
 * Only for the four default names, and this is the point of the distinction:
 * the merge is something compose does to the file it chose for itself, and a
 * `docker-compose.dev.yml` is never that file. Nor is the override matched by
 * extension — compose searches its own four spellings in order whatever the base
 * file is called, so `compose.yaml` beside `compose.override.yml` is a pair.
 *
 * `up` is the command that fans out: the bare action, plus one per declared
 * service. Unlike cargo's `run` the bare one stays — `docker compose up` across
 * the whole stack is what most people want, not an ambiguity — and it fans out
 * even for a single-service file, so the menu reads the same whatever the file
 * holds. Six services is eleven actions rather than the thirty a full
 * services × commands product would be.
 *
 * Nothing here ever passes `-d`. A detached `up` exits at once: the item would
 * go idle with the containers still running, and ■ would stop nothing.
 */
async function parseCompose(
  text: string,
  file: string,
  cwd: vscode.Uri,
): Promise<ParsedManifest | undefined> {
  // Up and down are the compose item's fixed buttons. The setting supplies the
  // remaining context-menu commands and may repeat either without duplicating
  // it in the internal action list.
  const commands = [
    'up',
    'down',
    ...settingList('dockerComposeCommands', DEFAULT_COMPOSE_COMMANDS).filter(
      (command) => command !== 'up' && command !== 'down',
    ),
  ];

  const lines = text.split(/\r?\n/);
  const services = yamlBlockKeys(lines, 'services')
    .map((entry) => entry.name)
    .filter(Boolean);

  // A name the scan was sure about needs nothing else; one it matched by
  // convention has to show a compose file's own shape before it is believed. A
  // YAML file says nothing about what it is, and `deploy.staging.yml` sitting
  // beside a compose file is not the only way to be wrong about that.
  const named = COMPOSE_DEFAULT_FILES.includes(file);
  if (!named && services.length === 0 && !lines.some((line) => /^include:\s*(#.*)?$/.test(line))) {
    return undefined;
  }

  const program = composeProgram();
  const files = ['-f', file];
  const override = named ? await composeOverride(cwd) : undefined;
  if (override) {
    files.push('-f', override);
  }
  // The Compose Spec's own top-level `name:`, so the heading reads the project's
  // name rather than the folder it happens to sit in.
  const project = /^name:\s*["']?([^"'#\s]+)/m.exec(text);

  const tasks: RawTask[] = [];
  const push = (name: string, args: string[]) => {
    const argv = [...program, ...files, ...args];
    tasks.push({ name, command: argv.join(' '), argv });
  };

  const seen = new Set<string>();
  for (const entry of commands) {
    const listed = known(DOCKER_COMPOSE_COMMANDS, entry);
    // A command of the user's own is split into words, minus any request to
    // detach. A detached row exits the moment it starts, leaving the containers
    // up, the square with nothing to stop and the mark on the row telling the
    // truth only by accident — which is the one thing this setting promises
    // never happens, and splitting entries into words is what made `up -d`
    // reach the terminal at all.
    const args = listed ?? composeUserArgs(entry);
    if (args.length === 0) {
      continue;
    }
    // Named by what it runs rather than by what was written, so a dropped `-d`
    // does not leave a row whose label promises what the terminal never got.
    // That also lands `up -d` back on `up`, where the per-service rows, the
    // container mark and the square all know what to do with it.
    const name = listed ? entry : args.join(' ');
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    push(name, args);
    if (name === 'up') {
      for (const service of services) {
        push(`up: ${service}`, [...args, service]);
      }
    }
  }

  // `up`, `down` and the per-service `up: <service>` rows are the file's; the
  // rest are `dockerComposeCommands`. A service deleted from the file is gone.
  return { tasks, packageName: project?.[1], shaped: (name: string) => !name.startsWith('up: ') };
}

/** The override file beside a compose manifest, in compose's own order of preference. */
async function composeOverride(cwd: vscode.Uri): Promise<string | undefined> {
  for (const name of COMPOSE_OVERRIDE_FILES) {
    if (await exists(vscode.Uri.joinPath(cwd, name))) {
      return name;
    }
  }
  return undefined;
}

// --- Dockerfile --------------------------------------------------------------

/**
 * A Dockerfile declares build stages, not tasks, so what a file offers is the
 * handful of `docker` subcommands worth having on a list — the same shape cargo
 * and compose take, and for the same reason.
 *
 * `build` is not here. It is the one action every Dockerfile has, added by
 * `parseDockerfile` whatever the setting says, and listing it as a default would
 * invite somebody to take it out of a list that no longer controls it.
 */
const DEFAULT_DOCKERFILE_COMMANDS: ReadonlyArray<string> = ['run'];

/**
 * What each command name stands for. Unlike compose there is no shared prefix
 * past the program: `build` is the only one that reads the file at all, and the
 * rest address the image the build produced — which is why this is a function of
 * the file and its tag rather than the flat table `DOCKER_COMPOSE_COMMANDS` is.
 *
 * `run` is interactive on purpose. A container started from a VS Code terminal
 * has a real tty, and `--rm` is what keeps a row you pressed four times from
 * leaving four stopped containers behind.
 *
 * Each one places `extra` — whatever the setting wrote after the verb — itself,
 * because there is no one end of the line to append to: `docker build` takes its
 * context last, so a flag added after the `.` is a second context and an error,
 * and `run` takes the image last for the same reason. Splicing is what lets
 * `build --no-cache` still carry the `-f`, the `-t` and the context it needs.
 *
 * `tag` is a function rather than a string because a command may not want the
 * derived reference at all, and `build` may want one for a different stage than
 * the row it is on — see each entry.
 */
type DockerfileCommand = (at: {
  file: string;
  extra: string[];
  tag: (stage?: string) => string;
}) => string[];

/** Whether `extra` carries one of these options, as `--opt` or as `--opt=value`. */
function hasOption(extra: ReadonlyArray<string>, names: ReadonlyArray<string>): boolean {
  return extra.some((word) => names.some((name) => word === name || word.startsWith(`${name}=`)));
}

/** The value given to `--opt`, whether written as `--opt value` or `--opt=value`. */
function optionValue(extra: ReadonlyArray<string>, name: string): string | undefined {
  const at = extra.indexOf(name);
  if (at >= 0) {
    return extra[at + 1];
  }
  const joined = extra.find((word) => word.startsWith(`${name}=`));
  return joined?.slice(name.length + 1) || undefined;
}

/**
 * Whether `extra` already names the image for `docker push`.
 *
 * Reliable here and nowhere else: `push` takes exactly one `NAME[:TAG]`, and of
 * its options only `--platform` takes a value of its own — so a bare word that
 * is not that value is the reference the user meant. `run` is the opposite case
 * and is why this is not attempted for it: dozens of its options take values,
 * and reading the `api` of `--name api` as an image would leave the command with
 * no image at all.
 */
function pushNamesImage(extra: ReadonlyArray<string>): boolean {
  return extra.some(
    (word, at) => !word.startsWith('-') && extra[at - 1] !== '--platform',
  );
}

const DOCKERFILE_COMMANDS: Record<string, DockerfileCommand> = {
  // A `-t` of the user's own replaces the derived one rather than joining it:
  // `docker build -t mine -t api .` applies *both* names, which is what made the
  // documented way of naming an image yourself change nothing at all. And a
  // `--target` of the user's own is what the tag is derived for, so an entry
  // that builds one stage cannot land on the whole image's name.
  build: ({ file, extra, tag }) =>
    hasOption(extra, ['-t', '--tag'])
      ? ['build', '-f', file, ...extra, '.']
      : ['build', '-f', file, ...extra, '-t', tag(optionValue(extra, '--target')), '.'],
  // `-it` is always there, so an `-i`, `-t` or `-it` of the user's own — what is
  // left of a `-dit` — is not written a second time.
  run: ({ extra, tag }) => ['run', '--rm', '-it', ...extra.filter((word) => !/^-[it]+$/.test(word)), tag()],
  push: ({ extra, tag }) => (pushNamesImage(extra) ? ['push', ...extra] : ['push', ...extra, tag()]),
};

/**
 * `FROM node:20 AS builder`, which is the only line in a Dockerfile that names
 * something a row could stand for.
 *
 * The image is matched lazily and with anything in front of it, because the
 * flags come before it — `FROM --platform=$BUILDPLATFORM node:20 AS build` is
 * ordinary in a cross-built image — and `AS` is anchored to the end so a stage
 * called `as` in the image name cannot answer for it. Case-insensitive: the
 * instructions are conventionally shouted and the parser does not care.
 */
export const DOCKERFILE_STAGE = /^\s*FROM\s+.*?\s+AS\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*$/i;

/** Whether the file has anything to build at all. */
const DOCKERFILE_FROM = /^\s*FROM\s+\S/im;

/**
 * One component of the repository half of a reference, reduced to something
 * Docker will certainly accept.
 *
 * Docker's grammar for a component is `[a-z0-9]+` runs joined by a separator,
 * and a separator is a *single* `.` or `_`, or a `__`, or a run of `-`. Nothing
 * else: `my..app` and `a___b` are rejected outright with `invalid reference
 * format`, and a folder may be called either. Rather than police which runs are
 * legal, the alphanumeric runs are taken and joined with a single `-`, which is
 * always a valid separator — so every folder name on earth lands on a component
 * Docker parses.
 *
 * The dots go with them, and that is the point rather than a side effect:
 * Docker reads a *first* component containing a dot as a registry domain, so a
 * folder called `example.com` would have turned `push` into a push at a real
 * remote and `run` into a pull from one. The repository half here is always
 * rooted at the folder, so no dot may survive in it.
 *
 * Lower case because that half admits nothing else.
 */
function repositoryComponent(value: string): string {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
}

/**
 * The tag half, which is the permissive one: `[\w][\w.-]{0,127}`, case and all.
 * Only the leading character is constrained, and the length — 128 in total, and
 * a profile read off a file name is not bounded by anything else, so it is cut
 * rather than allowed to produce `invalid reference format`.
 */
function tagPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  return cleaned.slice(0, 128);
}

/**
 * The image a row builds and runs.
 *
 * Nothing in a Dockerfile says what the image should be called, and a `docker
 * build` with no `-t` leaves a dangling image with an id for a name — so the
 * folder it sits in is the name, which is the same thing compose does for a
 * project that does not name itself.
 *
 * The two things that tell the Dockerfiles of one folder apart sit in the two
 * halves a reference has, rather than being joined into one: the **stage** is a
 * path segment on the repository, the **profile** from the file name is the tag.
 * So `apps/api` holds
 *
 * - `Dockerfile` → `api`
 * - `Dockerfile` targeting `builder` → `api/builder`
 * - `Dockerfile.dev` → `api:dev`
 * - `Dockerfile.dev` targeting `builder` → `api/builder:dev`
 *
 * and no two of them can land on the same reference. Joining the two with a dash
 * could: a `Dockerfile.dev` with no target and a `Dockerfile` targeting a stage
 * called `dev` both read `api:dev`, and the second build would silently retag
 * the first — after which `run` starts an image built from the other file. A
 * separator cannot fix that, because every character Docker allows in a tag is
 * also one it allows in a stage name.
 *
 * The stage is lower-cased on its way into the repository half, which is the one
 * Docker insists on; the tag half keeps its case.
 */
function imageTag(cwd: vscode.Uri, file: string, stage?: string): string {
  const base = repositoryComponent(path.posix.basename(cwd.path)) || 'image';
  const repository = stage ? `${base}/${repositoryComponent(stage)}` : base;
  const tag = tagPart(dockerfileProfile(file) ?? '');
  return tag ? `${repository}:${tag}` : repository;
}

/**
 * The rows for one Dockerfile.
 *
 * `-f <file>` for the reason make, just and compose all name their own file:
 * what the scan saw is not what the runner would pick, and `docker build` looks
 * for `Dockerfile` in the context whatever else is beside it.
 *
 * The context is `.` — the directory the file sits in, which is the directory
 * every row already runs in. A Dockerfile kept in `docker/` and built from the
 * repository root is a real layout and not one any file says out loud, so the
 * honest default is the one every other manifest here uses: the folder the file
 * is in.
 *
 * `build` is the command that fans out: the bare action, plus one `build:
 * <stage>` per named stage, which is `--target` and a tag of its own. The bare
 * one stays even for a file whose last stage is named — `docker build` with no
 * target is what most people want, and the menu reads the same whatever the file
 * holds, which is the rule the compose rows already follow.
 */
function parseDockerfile(text: string, file: string, cwd: vscode.Uri): ParsedManifest | undefined {
  // A file matched by name that builds nothing is not a row — a `Dockerfile.md`
  // describing how to build one is matched by `DOCKERFILE_NAME` and has no
  // `FROM` in it. It comes back empty rather than undefined so the scan records
  // that the file was read and understood; see `emptyManifests`.
  if (!DOCKERFILE_FROM.test(text)) {
    return { tasks: [] };
  }

  // `build` is the Dockerfile's fixed action. The setting supplies the rest and
  // may repeat it without duplicating the row.
  const commands = [
    'build',
    ...settingList('dockerfileCommands', DEFAULT_DOCKERFILE_COMMANDS).filter(
      (command) => command !== 'build',
    ),
  ];

  const stages: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const stage = DOCKERFILE_STAGE.exec(line);
    // A stage may be named twice in a file that was edited badly, and a name
    // listed twice is a row whose key the scan would drop anyway.
    if (stage && !stages.includes(stage[1])) {
      stages.push(stage[1]);
    }
  }

  const tasks: RawTask[] = [];
  const push = (name: string, args: string[]) => {
    const argv = ['docker', ...args];
    tasks.push({ name, command: argv.join(' '), argv });
  };

  const seen = new Set<string>();
  for (const entry of commands) {
    // Split into words and named by what is left, so a request to detach is both
    // dropped and forgotten: a detached `run` exits at once, leaving the
    // container up, the square with nothing to stop and the spinner telling the
    // truth only by accident — and a row still labelled `run -d` would promise
    // what the terminal never got.
    const [head, ...extra] = undetached(words(entry));
    if (!head) {
      continue;
    }
    const name = [head, ...extra].join(' ');
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    // The verb alone decides what this is, so `build --no-cache` is still a
    // build and keeps the `-f`, the `-t` and the context that make it one —
    // matching the whole of what was written would have handed it to the branch
    // below, where `docker build --no-cache` is a build with no context at all
    // and fails before it starts. Looking the verb up after the stripping rather
    // than before it is also what lands `run -d` back on `run`.
    //
    // A verb that is nobody's but the user's gets no `-f` and no tag: `docker
    // builder prune` and `docker image ls` are the sort of thing written here,
    // and appending this file's image to one of them would be an argument nobody
    // asked for. A command that wants the image can name it — the reference is
    // the folder, and the setting says so.
    const listed = known(DOCKERFILE_COMMANDS, head);
    push(
      name,
      listed
        ? listed({ file, extra, tag: (stage) => imageTag(cwd, file, stage) })
        : [head, ...extra],
    );
    // Only the bare `build` fans out, which is the rule `parseCompose` already
    // follows for `up`: a verb carrying flags of its own is the one row that was
    // asked for, not a row per stage as well.
    if (name === 'build') {
      for (const stage of stages) {
        // Claimed here as well as pushed: a `build: deps` written into the
        // setting would otherwise produce a second row of that name, and the
        // scan's own per-manifest de-duplication would drop one of them without
        // saying which.
        seen.add(`build: ${stage}`);
        // Through the same builder as the row above, so the two cannot drift
        // over where a flag or the context belongs.
        push(
          `build: ${stage}`,
          DOCKERFILE_COMMANDS.build({
            file,
            extra: ['--target', stage],
            tag: (of) => imageTag(cwd, file, of),
          }),
        );
      }
    }
  }

  // `build` and its `build: <stage>` rows are the file's; the rest are
  // `dockerfileCommands`. A stage deleted from the file is gone.
  return { tasks, shaped: (name: string) => !name.startsWith('build: ') };
}

// --- shell scripts -----------------------------------------------------------

/**
 * Where shell scripts are looked for. Narrow on purpose: the convention is a
 * `.sh` under a `scripts` or `bin` folder, or in the root — and anything wider
 * turns every vendored helper in a repository into a row.
 *
 * `findFiles` matches its glob against the path *relative to the workspace
 * folder*, so the leading globstar is what carries the first two patterns past
 * the root. Without it `scripts` would have to be a directory at the very top,
 * and `apps/web/scripts/deploy.sh` — the case the nesting in the tree exists for
 * — would never be found at all. The third pattern keeps no prefix on purpose:
 * loose scripts are worth listing where a project root is, not in every
 * directory of the repository.
 */
/** Every shell extension as one glob tail: `*.{sh,bash,zsh,ksh}`. */
const SHELL_FILES = `*.{${SHELL_EXTENSIONS.join(',')}}`;

const DEFAULT_SHELL_SCRIPTS: ReadonlyArray<string> = [
  `**/scripts/**/${SHELL_FILES}`,
  `**/bin/**/${SHELL_FILES}`,
  SHELL_FILES,
];

/**
 * One glob per alternative a `{a,b}` group holds: `bin/*.{sh,bash}` becomes
 * `bin/*.sh` and `bin/*.bash`.
 *
 * The patterns are handed to `findFiles` as a single `{...}` group, and VS Code's
 * own glob parser reads a group with a flat scan — the first `}` closes it,
 * whatever sits nested inside. A braced pattern joined into that group would
 * therefore match nothing at all, and silently. Expanding first is what lets the
 * defaults above name four extensions on one readable line, and lets anyone write
 * a braced pattern of their own in the setting.
 */
export function expandBraces(pattern: string): string[] {
  let expanded = [pattern];
  // One group per pass, across every pattern the last pass produced, so the work
  // stops at the budget rather than at the end of an expansion nobody asked for:
  // groups multiply, and `{a,b}` twenty-five times over is thirty-three million
  // patterns and a frozen window. Twenty-one is what the defaults expand to.
  //
  // A pattern that wants more than the budget contributes nothing at all, and
  // that is the careful half. Handing it back with its braces intact was the
  // first answer, and it was worse than dropping it: the caller joins every
  // alternative into one `{…}` group, so a member that still carries braces
  // nests one group inside another — which, by the same flat-scan rule this
  // function exists for, is a glob that matches nothing. One unreasonable
  // pattern would have silently taken `scripts/` and `bin/` down with it.
  for (let pass = 0; pass <= MAX_GLOB_GROUPS; pass += 1) {
    const next: string[] = [];
    let opened = false;
    for (const one of expanded) {
      const parts = splitGroup(one);
      opened = opened || parts.length > 1 || parts[0] !== one;
      next.push(...parts);
      if (next.length > MAX_GLOB_ALTERNATIVES) {
        return [];
      }
    }
    // Nothing left to open — which is also how a pattern with an unbalanced
    // brace leaves, as itself, exactly as it was written.
    if (!opened) {
      return next;
    }
    expanded = next;
  }
  return [];
}

/** How far `expandBraces` will go before handing the pattern back as written. */
const MAX_GLOB_ALTERNATIVES = 256;
const MAX_GLOB_GROUPS = 12;

/** One pattern with its first `{a,b}` group opened, or the pattern as it was. */
function splitGroup(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    return [pattern];
  }
  const choices: string[] = [];
  let depth = 0;
  let start = open + 1;
  let close = -1;
  for (let at = open; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === '{') {
      depth += 1;
    } else if (char === ',' && depth === 1) {
      choices.push(pattern.slice(start, at));
      start = at + 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        choices.push(pattern.slice(start, at));
        close = at;
        break;
      }
    }
  }
  // An unclosed brace is not a group, and is left exactly as it was written.
  if (close === -1) {
    return [pattern];
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return choices.map((choice) => `${head}${choice}${tail}`);
}

/**
 * The words a Bourne-family script is run through. `bash` rather than the file
 * itself, because running `./deploy.sh` needs both the executable bit and a
 * shebang — and the bit is invisible to `vscode.workspace.fs` (`FilePermission`
 * carries only `Readonly`), so checking it would mean importing `node:fs` and
 * giving up Remote SSH and Dev Containers, which is the whole reason this file
 * imports nothing but `path` and `vscode`.
 *
 * Empty runs the path on its own, for anyone who wants exactly that.
 */
function shellRunner(): string[] {
  const configured = setting<string>('shellRunner');
  const value = (typeof configured === 'string' ? configured : 'bash').trim();
  return value ? value.split(/\s+/) : [];
}

/**
 * What the extensions `shellRunner` does not speak for are run through.
 *
 * A `.ps1` handed to `bash` is an error message rather than a task, so each of
 * the three Windows extensions says how it is started:
 *
 * - `powershell` and not `pwsh`: Windows PowerShell 5.1 ships with the OS and is
 *   still what a stock Windows has, where PowerShell 7 is an install away.
 *   `-File` is what makes the argument a script rather than a command to parse,
 *   and `-NoProfile` keeps a user's profile out of a task's output. Someone on 7
 *   sets `pwsh -NoProfile -File` here and nothing else changes. So does anyone
 *   whose execution policy needs an `-ExecutionPolicy Bypass` in front of the
 *   file — deliberately not the default: running a script is the user's call to
 *   make, and quietly stepping over the machine's policy to do it is not ours.
 * - `.bat` and `.cmd` are run as themselves, with no runner at all: they are
 *   already programs to Windows, and the shell a task starts in there —
 *   PowerShell, in a stock VS Code — takes the `./path/to/x.bat` this builds.
 *   `cmd.exe` as the terminal profile is the exception, and wants `cmd /c` here.
 */
const DEFAULT_SHELL_RUNNERS: Readonly<Record<string, string>> = {
  ps1: 'powershell -NoProfile -File',
  bat: '',
  cmd: '',
};

/**
 * The runner each extension is started with, the user's map over the built-in
 * one. An extension nobody has spoken for falls back to `shellRunner`, which is
 * what every Bourne-family script uses and what an unknown extension is most
 * likely to want.
 */
function shellRunners(): Record<string, string> {
  const configured = setting<unknown>('shellRunners');
  const overrides =
    configured && typeof configured === 'object' && !Array.isArray(configured)
      ? (configured as Record<string, unknown>)
      : {};
  const runners: Record<string, string> = { ...DEFAULT_SHELL_RUNNERS };
  for (const [extension, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      // Spelled as the file is — `.PS1` and `ps1` are one extension — and a
      // leading dot is dropped, since that is how anyone would write one.
      runners[extension.toLowerCase().replace(/^\./, '')] = value;
    }
  }
  return runners;
}

/** The lower-case extension of a file, without its dot. */
function extensionOf(file: vscode.Uri): string {
  return path.posix.extname(file.path).slice(1).toLowerCase();
}

/** Comment lines that are addressed to a tool rather than to a reader. */
const SHELL_PRAGMA = /^(shellcheck\b|vim:|emacs:|-\*-|!)/;

/**
 * How a comment opens, in the shells this scan reads. `#` is every Bourne shell
 * and PowerShell; `REM` and `::` are the two a batch file has, and `::` is a
 * label the parser skips rather than a comment keyword — which is exactly why
 * everybody writes comments with it.
 */
const SHELL_COMMENT = /^(#+|::+|rem\b)\s*/i;
/** Only `#`: in a Bourne or PowerShell file `REM=…` is an assignment, not a comment. */
const HASH_COMMENT = /^#+\s*/;

/**
 * The dimmed text a shell row gets: the first comment line in the file that was
 * written for a person. The shebang goes, and so do the editor and linter
 * pragmas that sit under it — the same idea as the `##` convention `MAKE_DOC`
 * reads, for files that have no convention of their own.
 *
 * Bounded to the head of the file rather than stopping at the first line of
 * code: `set -euo pipefail` and a `cd` to the repository root routinely sit
 * above the comment that says what the script is for.
 */
export function shellDescription(text: string, extension?: string): string | undefined {
  // The batch openers only for a batch file: `REM=$(git rev-parse HEAD)` in a
  // `.sh` is a variable, and `::` never opens a comment there.
  const comment = extension === undefined || extension === 'bat' || extension === 'cmd' ? SHELL_COMMENT : HASH_COMMENT;
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    const trimmed = line.trim();
    const opener = comment.exec(trimmed);
    if (!opener) {
      continue;
    }
    const body = trimmed.slice(opener[0].length).trim();
    if (body && !SHELL_PRAGMA.test(body)) {
      return body;
    }
  }
  return undefined;
}

/**
 * Every shell script the patterns find, as rows grouped by the directory they
 * sit in.
 *
 * One group per directory, not per file: twelve scripts across `scripts/` and
 * `bin/` are two headings rather than twelve one-row headings, where every group
 * affordance — fold, hide, rename, drag scope — would be per-script noise. Not
 * one workspace-wide heading either, which would lose the "where does this live"
 * cue the rest of the tree is organised around.
 *
 * The group's `manifest` is therefore the directory. Its ref is
 * `<folder>/scripts`, and a real manifest's always ends in a file name, so the
 * only way the two collide is a directory literally named `package.json`.
 */
async function collectShellScripts(exclude: string): Promise<ScriptEntry[]> {
  const patterns = settingList('shellScripts', DEFAULT_SHELL_SCRIPTS);
  if (patterns.length === 0) {
    return [];
  }
  const alternatives = patterns.flatMap(expandBraces);
  // Every pattern was dropped as unreasonable, and a glob of nothing would be a
  // glob that matches everything in some readings. There is nothing to look for.
  if (alternatives.length === 0) {
    return [];
  }
  const glob = alternatives.length === 1 ? alternatives[0] : `{${alternatives.join(',')}}`;
  const files = await vscode.workspace.findFiles(glob, exclude, MAX_SHELL_SCRIPTS);
  // By directory first, so a group's scripts are one run and the shallower
  // folders come first — the same shape the manifest sort above produces — and
  // alphabetically inside one, which is the order a folder is read in.
  files.sort((a, b) => {
    const left = path.posix.dirname(a.path);
    const right = path.posix.dirname(b.path);
    return left.length - right.length || left.localeCompare(right) || a.path.localeCompare(b.path);
  });

  const runner = shellRunner();
  const runners = shellRunners();
  const entries: ScriptEntry[] = [];
  // Only the description is kept out of each read: the text can run to a
  // megabyte, and two hundred of them held until the loop ends is a lot of
  // memory to spend on one dimmed line each.
  const descriptions = await inBatches(files, SCAN_CONCURRENCY, async (file) => {
    const text = await readText(file);
    return text !== undefined ? shellDescription(text, extensionOf(file)) : undefined;
  });

  for (const [at, file] of files.entries()) {
    const directory = directoryOf(file);
    // The workspace folder root, not the script's own directory: a
    // `scripts/deploy.sh` is written to be run from the root of the repository,
    // which is where `./scripts/deploy.sh` in a README means.
    const cwd = vscode.workspace.getWorkspaceFolder(file)?.uri ?? directory;
    const relative = (from: vscode.Uri, to: vscode.Uri) =>
      path.relative(from.fsPath, to.fsPath).split(path.sep).join('/');

    const inside = relative(cwd, file) || path.posix.basename(file.path);
    // A group in the root of its folder has no path of its own to show, so it
    // falls back to the folder's name — the same fallback a manifest's location
    // takes when it sits at the root.
    const location = relative(cwd, directory) || path.posix.basename(directory.path);
    // The extension decides the words in front of the path: `bash` for the
    // Bourne family, PowerShell for a `.ps1`, and nothing at all for a `.bat`,
    // which is a program to Windows already. See `DEFAULT_SHELL_RUNNERS`.
    const extension = extensionOf(file);
    // `known` rather than `in`: a file named `notes.toString` must not hand
    // back a function off `Object.prototype`.
    const words = known(runners, extension)?.trim().split(/\s+/).filter(Boolean) ?? runner;
    const argv = [...words, `./${inside}`];

    entries.push({
      // The file name keeps its extension: it is the identity in `scriptKey`,
      // the terminal's title and the tooltip, and the category tokeniser splits
      // `deploy.sh` to `['deploy', 'sh']` so the icon rules still read it.
      key: scriptKey(directory.toString(), path.posix.basename(file.path)),
      name: path.posix.basename(file.path),
      command: descriptions[at] ?? argv.join(' '),
      argv,
      manifest: directory,
      file,
      kind: 'shell',
      cwd,
      location,
      directory: location.includes('/') ? location.slice(0, location.lastIndexOf('/')) : '',
    });
  }

  return entries;
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

/**
 * A text file, or nothing when it is missing, unreadable or over `maxBytes`.
 * Exported for the icon theme reader, which wants the same guard with a larger
 * budget: a pack's theme file runs to megabytes where a manifest never does.
 */
export async function readText(uri: vscode.Uri, maxBytes = MAX_MANIFEST_BYTES): Promise<string | undefined> {
  try {
    // Asked of the file system first, so a huge file is never pulled into the
    // extension host only to be thrown away. The check after the read stays: the
    // file can grow between the two calls.
    const info = await vscode.workspace.fs.stat(uri);
    if (info.size > maxBytes) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxBytes) {
      return undefined;
    }
    const text = Buffer.from(bytes).toString('utf8');
    // Windows editors like to lead with a byte-order mark, which JSON.parse and
    // the TOML reader both reject, and which `\s` in a Makefile regex swallows.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
  /**
   * Where in `out` a comma sits that would be trailing if the next significant
   * character closes its scope. Handled here rather than by a regex afterwards,
   * because only this loop knows which commas are inside strings — a command
   * like `echo {foo,}` must come through untouched.
   */
  let pendingComma = -1;

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
      pendingComma = -1;
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
    if (char === ',') {
      pendingComma = out.length;
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      if (pendingComma >= 0) {
        out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      }
      pendingComma = -1;
      out += char;
      continue;
    }
    if (!/\s/.test(char)) {
      pendingComma = -1;
    }
    out += char;
  }

  try {
    return JSON.parse(out);
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

// --- launching ---------------------------------------------------------------

/**
 * The program and its arguments — what actually runs.
 *
 * A vector rather than a command line, all the way from the parser, because a
 * task name is the manifest's text and the terminal is a shell: a name holding
 * `$(…)`, a backtick or a space would otherwise be read as code on its way
 * through. Handing VS Code the pieces lets it quote each one for the shell that
 * terminal actually runs — sh, cmd.exe and PowerShell all want something
 * different, and double quotes, which is what `JSON.stringify` produces, leave
 * substitution alive in the first of them.
 */
export function launchArgv(script: ScriptEntry): string[] {
  return script.argv ?? [...RUNNERS[resolvePackageManager(script)], script.name];
}

/** The same command as a person reads it: the row's tooltip and the picker. */
export function commandFor(script: ScriptEntry): string {
  return launchArgv(script).map(displayArg).join(' ');
}

/**
 * An argument that reads the same whatever the shell: word characters and the
 * punctuation task names and paths are normally built from. Anything else — a
 * space, a quote, `$`, a backtick — has to be quoted on its way to one, which
 * is what `buildTask` asks VS Code for.
 */
export function plainArgument(value: string): boolean {
  return /^[\w.:@/=+-]+$/.test(value);
}

/**
 * Quoting for the eye alone — enough to show where an argument begins and ends.
 * The quoting that reaches a shell is VS Code's; see `launchArgv`.
 */
function displayArg(value: string): string {
  return plainArgument(value) ? value : JSON.stringify(value);
}

export function resolvePackageManager(script: ScriptEntry): PackageManager {
  // A deno.json(c) task can only be run by Deno, so it ignores any override.
  if (script.kind === 'deno') {
    return 'deno';
  }

  // Matched against the known runners rather than trusted: a settings.json can
  // hold any string at all, and this one is the first word of a command line.
  // Anything else — 'auto' included — falls through to what the scan detected.
  const configured = setting<string>('packageManager', script.manifest);
  const chosen = PACKAGE_MANAGERS.find((manager) => manager === configured);
  if (chosen) {
    return chosen;
  }
  return detected.get(script.cwd.toString()) ?? 'npm';
}

async function detectPackageManagers(entries: ScriptEntry[], started: number): Promise<void> {
  // Per directory, for this walk only. A monorepo's packages all climb through
  // the same parents to the one lock file at the root, and each of those parents
  // is a dozen stats — asked once here rather than once per package.
  const lockFiles = new Map<string, PackageManager | undefined>();
  for (const entry of entries) {
    const dir = entry.cwd.toString();
    if (entry.kind !== 'npm' || detected.has(dir)) {
      continue;
    }
    const found = await detectPackageManager(entry, lockFiles);
    // A `resetSources` during the stat walk has cleared the map. A result
    // computed from the old hints must not land in it: the fresh scan would see
    // the directory as already detected, skip it, and keep launching the
    // package's scripts with the runner the change was meant to replace.
    if (started !== generation) {
      return;
    }
    // The miss is recorded too. `npm` is what `resolvePackageManager` falls back
    // to anyway, so writing it down is storing the answer rather than guessing
    // one — and it is what keeps a 40-script package with no lock file from
    // walking its parent directories 40 times over.
    detected.set(dir, found ?? 'npm');
  }
}

async function detectPackageManager(
  entry: ScriptEntry,
  lockFiles: Map<string, PackageManager | undefined>,
): Promise<PackageManager | undefined> {
  const hints = nodeHints.get(entry.manifest.toString());

  // 1. An explicit "packageManager": "<name>@<version>" field wins.
  const field = hints?.packageManager ?? '';
  const fromField = ENGINE_KEYS.find((manager) => field.startsWith(`${manager}@`));
  if (fromField) {
    return fromField;
  }

  // 2. Then lock and config files, nearest-first: the package itself, then each
  //    parent up to the workspace folder, where monorepo lock files live. A lock
  //    file is what the project was actually installed with; `engines` below
  //    only pins versions, and `"npm": ">=9"` beside a pnpm-lock.yaml is the
  //    usual way of saying which npm is too old, not that npm is the runner.
  const fromLock = await lockFileManager(entry, lockFiles);
  if (fromLock) {
    return fromLock;
  }

  // 3. Finally the "engines" field, e.g. { "engines": { "pnpm": ">=9" } }. npm
  //    is left out: it is the fallback anyway, so naming it here says nothing.
  const engines = hints?.engines;
  return engines
    ? ENGINE_KEYS.find((manager) => manager !== 'npm' && typeof engines[manager] === 'string')
    : undefined;
}

async function lockFileManager(
  entry: ScriptEntry,
  lockFiles: Map<string, PackageManager | undefined>,
): Promise<PackageManager | undefined> {
  const root = vscode.workspace.getWorkspaceFolder(entry.manifest)?.uri.path;
  let current = entry.cwd;
  for (;;) {
    const key = current.toString();
    let found = lockFiles.get(key);
    if (!lockFiles.has(key)) {
      found = await detectionFileManager(current);
      lockFiles.set(key, found);
    }
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
