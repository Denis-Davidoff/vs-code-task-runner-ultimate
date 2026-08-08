import * as path from 'path';
import * as vscode from 'vscode';

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno';

/** How each runner invokes a named script. */
const RUNNERS: Record<PackageManager, (script: string) => string> = {
  npm: (script) => `npm run ${script}`,
  yarn: (script) => `yarn ${script}`,
  pnpm: (script) => `pnpm run ${script}`,
  bun: (script) => `bun run ${script}`,
  deno: (script) => `deno task ${script}`,
};

/** Manifests that hold runnable scripts, and the field they live in. */
const MANIFEST_GLOB = '**/{package.json,deno.json,deno.jsonc}';

/** Task type used for the tasks this extension executes. Must match contributes.taskDefinitions. */
const TASK_TYPE = 'taskRunnerUltimate';
const TASK_SOURCE = 'scripts';
const CONTEXT_PICKER_OPEN = 'taskRunnerUltimate.pickerOpen';
const CONTEXT_RUNNING_COUNT = 'taskRunnerUltimate.runningCount';
/** Highest count with a dedicated badge icon; above this the "9+" icon is used. */
const MAX_BADGE = 9;
/**
 * Ceiling on manifests read in one scan. Every hit is opened and parsed, and
 * its directory is stat-walked for lock files, so this bounds the work a
 * pathological workspace can ask for. Reaching it is reported rather than
 * silently truncating the list.
 */
const MAX_MANIFESTS = 2000;
/** The truncation warning is shown once per window, not once per scan. */
let warnedAboutTruncation = false;

interface ScriptEntry {
  /** Stable identity of a script: its manifest plus the script name. */
  key: string;
  /** Script name as written in the manifest. */
  name: string;
  /** Raw command the script runs. */
  command: string;
  /** package.json / deno.json(c) the script came from. */
  manifest: vscode.Uri;
  /** A deno.json(c) task always runs through `deno task`, whatever else is detected. */
  isDenoTask: boolean;
  /** Directory the script must run in. */
  cwd: vscode.Uri;
  /** Manifest path relative to its workspace folder. */
  location: string;
  /** Directory part of `location`, empty for a manifest at the workspace root. */
  directory: string;
  /** "name" field of the manifest, if any. */
  packageName?: string;
}

/**
 * Lock and config files that identify a runner, checked in this order within a
 * directory. Deno comes last: in a project that also has a package.json, an
 * npm-family lock file is the better signal for how to run its scripts.
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

/**
 * Everything a scan depends on: the manifests it reads scripts from, plus the
 * lock and config files runner detection consults. Watching only the manifests
 * would leave a package running under the wrong runner after a lock file
 * appears, so both go through the same watcher.
 */
const WATCH_GLOB = `**/{${[
  ...new Set(['package.json', 'deno.json', 'deno.jsonc', ...DETECTION_FILES.map(([file]) => file)]),
].join(',')}}`;

interface CategoryRule {
  /** Tokens the script name (or, as a last resort, its command) is matched against. */
  match: string[];
  /** Codicon id shown for scripts in this category. */
  icon: string;
  /** Theme colour id the icon is tinted with. */
  color: string;
}

/** Built-in categories, checked in this order after any user-defined ones. */
const DEFAULT_CATEGORIES: ReadonlyArray<CategoryRule> = [
  {
    match: ['dev', 'start', 'serve', 'server', 'watch', 'preview', 'storybook'],
    icon: 'play',
    color: 'taskRunnerUltimate.category.run',
  },
  {
    match: ['test', 'tests', 'spec', 'e2e', 'jest', 'vitest', 'cypress', 'playwright', 'coverage'],
    icon: 'beaker',
    color: 'taskRunnerUltimate.category.test',
  },
  {
    match: ['lint', 'format', 'fmt', 'prettier', 'eslint', 'stylelint', 'typecheck', 'tsc', 'check'],
    icon: 'law',
    color: 'taskRunnerUltimate.category.quality',
  },
  {
    match: ['build', 'compile', 'bundle', 'dist', 'prepack', 'prepare'],
    icon: 'package',
    color: 'taskRunnerUltimate.category.build',
  },
  {
    match: ['release', 'publish', 'deploy', 'version', 'changeset'],
    icon: 'rocket',
    color: 'taskRunnerUltimate.category.release',
  },
  {
    match: ['migrate', 'migration', 'seed', 'db', 'prisma', 'generate', 'codegen'],
    icon: 'database',
    color: 'taskRunnerUltimate.category.data',
  },
  {
    match: ['clean', 'clear', 'reset', 'rimraf', 'purge'],
    icon: 'trash',
    color: 'taskRunnerUltimate.category.clean',
  },
];

let cache: ScriptEntry[] | undefined;
/** Script key -> its running task execution. */
const running = new Map<string, vscode.TaskExecution>();

/**
 * Drops everything derived from the manifests and repaints both surfaces.
 *
 * The detected runners go too: a package.json carries `packageManager` and
 * `engines`, so a change to it can move a package to a different runner, and a
 * stale entry would keep launching scripts with the old one. Re-detecting costs
 * a handful of stat calls per package on top of the rescan the cleared cache
 * already forces, which is the same work the Refresh command has always done.
 */
function invalidate(): void {
  cache = undefined;
  detected.clear();
  treeChanged.fire();
  // The picker holds its own copy of the list, so it has to be told as well.
  void activePicker?.reload();
}

/**
 * Repaints both surfaces from the scripts already in hand. For changes to how a
 * script is presented — starred, renamed — where the manifests themselves have
 * not moved and a rescan would be wasted work.
 */
function repaint(): void {
  treeChanged.fire();
  activePicker?.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
  storage = context.workspaceState;

  for (const exec of vscode.tasks.taskExecutions) {
    const key = keyForTask(exec.task);
    if (key) {
      running.set(key, exec);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('taskRunnerUltimate.show', showScriptPicker),
    vscode.commands.registerCommand('taskRunnerUltimate.restartActive', restartActiveItem),
    vscode.commands.registerCommand('taskRunnerUltimate.refresh', async () => {
      invalidate();
      await collectScripts();
      vscode.window.setStatusBarMessage('Task Runner Ultimate: reloaded', 2000);
    }),
    // One command per badge count: the toolbar icon is static, so the visible
    // entry is swapped via the runningCount context key (see contributes.menus).
    ...badgeCommandIds().map((id) => vscode.commands.registerCommand(id, showScriptPicker)),
    vscode.commands.registerCommand('taskRunnerUltimate.runItem', (node?: TreeNode) => runNode(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.stopItem', (node?: TreeNode) => stopNode(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.restartItem', (node?: TreeNode) => restartNode(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.toggleItem', (node?: TreeNode) => toggleNode(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.addFavorite', (node?: TreeNode) => setFavorite(node, true)),
    vscode.commands.registerCommand('taskRunnerUltimate.removeFavorite', (node?: TreeNode) => setFavorite(node, false)),
    vscode.commands.registerCommand('taskRunnerUltimate.editTitle', (node?: TreeNode) => editTitle(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.stopAll', stopAllTasks),
    vscode.commands.registerCommand('taskRunnerUltimate.restartAll', restartAllTasks),
    vscode.tasks.registerTaskProvider(TASK_TYPE, {
      provideTasks: async () => (await collectScripts()).map(buildTask),
      resolveTask: async (task) => {
        const { manifest, script } = task.definition as { manifest?: string; script?: string };
        if (!manifest || !script) {
          return undefined;
        }
        const entry = (await collectScripts()).find((item) => item.key === scriptKey(manifest, script));
        return entry ? buildTask(entry) : undefined;
      },
    }),
    vscode.tasks.onDidStartTask(({ execution }) => {
      const key = keyForTask(execution.task);
      if (key) {
        running.set(key, execution);
      }
      onStateChanged();
    }),
    vscode.tasks.onDidEndTask(({ execution }) => {
      const key = keyForTask(execution.task);
      if (key) {
        running.delete(key);
      }
      onStateChanged();
    }),
  );

  context.subscriptions.push(...createTree());

  const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
  // The events carry the changed URI, which `invalidate` has no use for.
  watcher.onDidChange(() => invalidate());
  watcher.onDidCreate(() => invalidate());
  watcher.onDidDelete(() => invalidate());
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('taskRunnerUltimate.exclude')) {
        invalidate();
      }
      if (event.affectsConfiguration('taskRunnerUltimate.showInStatusBar')) {
        syncStatusBar(context);
      }
    }),
  );

  syncStatusBar(context);
  onStateChanged();
}

export function deactivate(): void {
  running.clear();
}

// --- running state -----------------------------------------------------------

/** Task executions that are running but are not backed by a package.json script. */
function foreignExecutions(): vscode.TaskExecution[] {
  return vscode.tasks.taskExecutions.filter((exec) => !keyForTask(exec.task));
}

function runningCount(): number {
  return running.size + foreignExecutions().length;
}

function onStateChanged(): void {
  const count = runningCount();
  void vscode.commands.executeCommand('setContext', CONTEXT_RUNNING_COUNT, Math.min(count, MAX_BADGE + 1));
  updateStatusBar(count);
  activePicker?.refresh();
  treeChanged.fire();
  if (treeView) {
    // The activity bar badge is a real API here, unlike the editor toolbar one.
    treeView.badge = count > 0 ? { value: count, tooltip: `${count} running task(s)` } : undefined;
  }
}

function scriptKey(manifest: string, name: string): string {
  return `${manifest}::${name}`;
}

/** Maps a task back to a script key, for both our tasks and built-in npm tasks. */
function keyForTask(task: vscode.Task): string | undefined {
  const definition = task.definition as { type: string; script?: string; path?: string; manifest?: string };

  if (definition.type === TASK_TYPE) {
    return definition.manifest && definition.script
      ? scriptKey(definition.manifest, definition.script)
      : undefined;
  }

  if (definition.type === 'npm' && definition.script) {
    const folder = typeof task.scope === 'object' ? (task.scope as vscode.WorkspaceFolder) : undefined;
    if (!folder) {
      return undefined;
    }
    const manifest = vscode.Uri.joinPath(folder.uri, definition.path ?? '', 'package.json');
    return scriptKey(manifest.toString(), definition.script);
  }

  return undefined;
}

// --- favorites and custom titles ---------------------------------------------

/**
 * Both annotate a script that lives in a file we do not own — a package.json is
 * the project's, often someone else's, and a starred or renamed script must not
 * show up in its diff. They go to the workspace's own storage instead:
 * per-workspace, per-machine, invisible to git, and disposed with the workspace.
 *
 * The trade-off is that neither travels: a second machine starts with an empty
 * FAVORITES, and a team cannot share one. Moving either to a setting would buy
 * that at the cost of rewriting settings.json on every click of a star.
 */
const FAVORITES_KEY = 'favorites';
const TITLES_KEY = 'titles';

let storage: vscode.Memento | undefined;

/**
 * Storage identity of a script — the namespace it belongs to plus its name,
 * e.g. `my-app/packages/api/package.json::dev`. Deliberately not the absolute
 * URI `ScriptEntry.key` uses: that one is rebuilt on every scan and is fine as a
 * runtime handle, but a workspace moved to another path on disk would lose all
 * of its favorites.
 */
function scriptRef(script: ScriptEntry): string {
  const folder = vscode.workspace.getWorkspaceFolder(script.manifest);
  const where = folder ? `${folder.name}/${script.location}` : script.manifest.toString();
  return `${where}::${script.name}`;
}

function favoriteRefs(): string[] {
  const stored = storage?.get<unknown>(FAVORITES_KEY);
  return Array.isArray(stored) ? stored.filter((ref): ref is string => typeof ref === 'string') : [];
}

function isFavorite(script: ScriptEntry): boolean {
  return favoriteRefs().includes(scriptRef(script));
}

/**
 * The favorites in the order they were starred, resolved against the current
 * scan. A ref that resolves to nothing is skipped but kept in storage — the
 * script may be behind a closed workspace folder, and dropping it here would
 * quietly delete a favorite the user still wants.
 */
function favoriteScripts(scripts: ScriptEntry[]): ScriptEntry[] {
  const byRef = new Map(scripts.map((script) => [scriptRef(script), script]));
  return favoriteRefs()
    .map((ref) => byRef.get(ref))
    .filter((script): script is ScriptEntry => script !== undefined);
}

async function setFavorite(node: TreeNode | undefined, favorite: boolean): Promise<void> {
  if (node?.kind !== 'script') {
    return;
  }
  const ref = scriptRef(node.script);
  const refs = favoriteRefs().filter((item) => item !== ref);
  if (favorite) {
    refs.push(ref);
  }
  await storage?.update(FAVORITES_KEY, refs);
  repaint();
}

function customTitles(): Record<string, string> {
  const stored = storage?.get<unknown>(TITLES_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, string>)
    : {};
}

function customTitle(script: ScriptEntry): string | undefined {
  const title = customTitles()[scriptRef(script)];
  return typeof title === 'string' && title ? title : undefined;
}

/** What the lists show for a script: the user's title if it has one, else its name. */
function displayName(script: ScriptEntry): string {
  return customTitle(script) ?? script.name;
}

/**
 * Renames a script for display only. The manifest is never touched: the name in
 * it is what the package manager is asked to run, so rewriting it would either
 * break the script or force a change to a file the user did not ask us to edit.
 */
async function editTitle(node: TreeNode | undefined): Promise<void> {
  if (node?.kind !== 'script') {
    return;
  }
  const script = node.script;
  const entered = await vscode.window.showInputBox({
    title: `Rename "${script.name}"`,
    prompt: 'Shown in this list only — the script in the manifest keeps its name. Leave empty to restore it.',
    value: displayName(script),
    placeHolder: script.name,
  });
  if (entered === undefined) {
    return;
  }

  const titles = { ...customTitles() };
  const title = entered.trim();
  if (title && title !== script.name) {
    titles[scriptRef(script)] = title;
  } else {
    delete titles[scriptRef(script)];
  }
  await storage?.update(TITLES_KEY, titles);
  repaint();
}

// --- activity bar tree -------------------------------------------------------

type TreeNode =
  | { kind: 'group'; id: string; label: string; detail?: string; folder?: string; icon?: string; children: TreeNode[] }
  | { kind: 'script'; script: ScriptEntry; inFavorites?: boolean }
  | { kind: 'foreign'; execution: vscode.TaskExecution };

const treeChanged = new vscode.EventEmitter<void>();
let treeView: vscode.TreeView<TreeNode> | undefined;

/** Private URI scheme for group rows, so decorations cannot hit real files. */
const DECORATION_SCHEME = 'taskrunnerultimate';
const TITLE_COLOR = 'taskRunnerUltimate.sourceTitleForeground';

function createTree(): vscode.Disposable[] {
  const provider: vscode.TreeDataProvider<TreeNode> = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem: treeItemFor,
    getChildren: async (node) => {
      if (!node) {
        return buildTreeRoots(await collectScripts());
      }
      return node.kind === 'group' ? node.children : [];
    },
  };

  const view = vscode.window.createTreeView('taskRunnerUltimate.tree', { treeDataProvider: provider });
  treeView = view;

  const decorations = vscode.window.registerFileDecorationProvider({
    provideFileDecoration: (uri) =>
      uri.scheme === DECORATION_SCHEME ? { color: new vscode.ThemeColor(TITLE_COLOR) } : undefined,
  });

  const visibility = view.onDidChangeVisibility(({ visible }) => {
    const opensDropdown = vscode.workspace
      .getConfiguration('taskRunnerUltimate')
      .get<boolean>('openDropdownFromActivityBar', false);
    if (visible && opensDropdown) {
      void showScriptPicker();
    }
  });

  return [treeChanged, view, visibility, decorations];
}

/**
 * One group per manifest. Running scripts stay in the group they belong to but
 * float to the top of it, and groups that have something running float to the
 * top of the tree — so whatever is alive is always the first thing on screen.
 */
function buildTreeRoots(scripts: ScriptEntry[]): TreeNode[] {
  const groups: Array<{ node: TreeNode & { kind: 'group' }; hasRunning: boolean }> = [];
  const byManifest = new Map<string, (typeof groups)[number]>();

  for (const script of scripts) {
    const key = script.manifest.toString();
    let group = byManifest.get(key);
    if (!group) {
      group = {
        node: {
          kind: 'group',
          id: `group:${key}`,
          label: packageTitle(script),
          detail: packagePath(script),
          folder: packageFolder(script),
          icon: groupIcon(script),
          children: [],
        },
        hasRunning: false,
      };
      byManifest.set(key, group);
      groups.push(group);
    }

    const node: TreeNode = { kind: 'script', script };
    if (running.has(script.key)) {
      // Running first, in the order they were declared.
      const insertAt = group.node.children.filter(
        (child) => child.kind === 'script' && running.has(child.script.key),
      ).length;
      group.node.children.splice(insertAt, 0, node);
      group.hasRunning = true;
    } else {
      group.node.children.push(node);
    }
  }

  const roots: TreeNode[] = [
    ...groups.filter((group) => group.hasRunning).map((group) => group.node),
    ...groups.filter((group) => !group.hasRunning).map((group) => group.node),
  ];

  // Tasks that are not backed by a manifest have no group of their own.
  const foreign = foreignExecutions();
  if (foreign.length > 0) {
    roots.unshift({
      kind: 'group',
      id: 'group:foreign',
      label: `Other tasks (${foreign.length})`,
      // Nothing here comes from a manifest, so there is no runner to name. What
      // the group has in common is that all of it is already running.
      icon: 'pulse',
      children: foreign.map((execution): TreeNode => ({ kind: 'foreign', execution })),
    });
  }

  // Favorites sit above everything, including running groups: a pinned list is
  // only worth pinning if it does not move. The scripts stay in their own group
  // as well — this is a second way in, not a way out of the package it lives in.
  const favorites = favoriteScripts(scripts);
  if (favorites.length > 0) {
    roots.unshift({
      kind: 'group',
      id: 'group:favorites',
      label: 'Favorites',
      icon: 'star-full',
      children: favorites.map((script): TreeNode => ({ kind: 'script', script, inFavorites: true })),
    });
  }

  return roots;
}

function treeItemFor(node: TreeNode): vscode.TreeItem {
  if (node.kind === 'group') {
    // Group rows are upper-cased with separators opened up; the tooltip keeps
    // the name exactly as written in the manifest.
    const title = node.label.toUpperCase().replace(/[-_]+/g, ' ');
    // The folder is part of the label rather than a description on purpose: the
    // decoration below tints the whole label, so an arrow-joined title keeps one
    // colour across the row instead of a tinted title beside a dimmed path.
    //
    // It stays lower-case against the upper-cased title: both halves carry the
    // same colour, so case is the only thing left to separate the name from the
    // path it lives at — and a path reads as a path in the case it is typed in.
    const heading = node.folder ? `${title} → ${node.folder.toLowerCase()}` : title;
    const item = new vscode.TreeItem(heading, vscode.TreeItemCollapsibleState.Expanded);
    item.tooltip = node.detail ? `${node.label} — ${node.detail}` : node.label;
    // A resourceUri makes the row eligible for a file decoration, the only API
    // that can colour a tree label. The scheme is ours, so the decoration never
    // leaks onto the real file in the explorer.
    //
    // The colour lands on the whole resource label, and `.label-description`
    // has no colour of its own (only opacity), so a visible description would
    // be tinted too. The path therefore lives in the tooltip and the row shows
    // the title alone — that keeps the colour on the title and nothing else.
    item.resourceUri = vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${node.detail ?? node.label}` });
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(TITLE_COLOR));
    }
    item.id = node.id;
    item.contextValue = 'group';
    return item;
  }

  if (node.kind === 'foreign') {
    const item = new vscode.TreeItem(node.execution.task.name);
    item.description = node.execution.task.source ? `${node.execution.task.source} task` : 'task';
    item.iconPath = new vscode.ThemeIcon('sync~spin');
    item.contextValue = 'foreignTask';
    item.command = { command: 'taskRunnerUltimate.toggleItem', title: 'Stop', arguments: [node] };
    return item;
  }

  const isRunning = running.has(node.script.key);
  const item = new vscode.TreeItem(displayName(node.script));
  // A starred script is on screen twice, under FAVORITES and in its own group.
  // Without ids of its own the tree cannot tell the two rows apart, and the
  // selection would jump between them. Built from the absolute `key` rather than
  // the storage ref, which trades uniqueness for portability.
  item.id = `${node.inFavorites ? 'fav' : 'pkg'}:${node.script.key}`;
  item.description = scriptDescription(node.script, node.inFavorites);
  item.tooltip = `${commandFor(node.script)}\n${node.script.location}`;
  item.iconPath = iconFor(node.script, isRunning);
  // Three independent axes in one value, matched a piece at a time by the
  // `when` clauses in contributes.menus.
  item.contextValue = `script:${isRunning ? 'running' : 'idle'}:${isFavorite(node.script) ? 'fav' : 'nofav'}`;
  item.command = {
    command: 'taskRunnerUltimate.toggleItem',
    title: isRunning ? 'Stop' : 'Run',
    arguments: [node],
  };
  return item;
}

/**
 * Dimmed text after the label, in the tree and in the picker alike. The command
 * is always in it; the rest adds back whatever the label stopped saying — the
 * real script name once the row has been renamed, and the package it belongs to
 * once it is listed under FAVORITES, away from the group heading that would
 * otherwise answer that.
 *
 * Keeping the manifest's own name here is also what leaves a renamed script
 * findable by it: the picker matches on the description too.
 */
function scriptDescription(script: ScriptEntry, inFavorites = false): string {
  const parts: string[] = [];
  if (customTitle(script)) {
    parts.push(script.name);
  }
  if (inFavorites) {
    parts.push(packageOrigin(script));
  }
  parts.push(script.command);
  return parts.join(' · ');
}

/** Namespace a script belongs to: its package's name, or where the manifest lives. */
function packageOrigin(script: ScriptEntry): string {
  return script.packageName ?? packagePath(script);
}

// --- script categories -------------------------------------------------------

/**
 * Classifies a script by name: first token first (`test:e2e` is a test, `build:prod`
 * is a build), then any token, then the command it runs — which catches scripts
 * named `ci` that in fact call `vitest`.
 */
function categoryFor(script: ScriptEntry): CategoryRule | undefined {
  const rules = [...userCategories(), ...DEFAULT_CATEGORIES];
  const tokens = script.name.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

  const first = tokens[0];
  const byFirstToken = first && rules.find((rule) => rule.match.includes(first));
  if (byFirstToken) {
    return byFirstToken;
  }

  const byAnyToken = rules.find((rule) => tokens.some((token) => rule.match.includes(token)));
  if (byAnyToken) {
    return byAnyToken;
  }

  const command = script.command.toLowerCase();
  return rules.find((rule) => rule.match.some((token) => command.includes(token)));
}

/** User rules take precedence, so a single entry can override a built-in category. */
function userCategories(): CategoryRule[] {
  const configured = vscode.workspace
    .getConfiguration('taskRunnerUltimate')
    .get<CategoryRule[]>('categories', []);

  return (Array.isArray(configured) ? configured : []).filter(
    (rule): rule is CategoryRule =>
      Array.isArray(rule?.match) && typeof rule.icon === 'string' && typeof rule.color === 'string',
  );
}

function iconFor(script: ScriptEntry, isRunning: boolean): vscode.ThemeIcon {
  const category = categoryFor(script);
  const colored = vscode.workspace.getConfiguration('taskRunnerUltimate').get<boolean>('colorIcons', true);
  const color = category && colored ? new vscode.ThemeColor(category.color) : undefined;
  return new vscode.ThemeIcon(isRunning ? 'sync~spin' : category?.icon ?? 'play', color);
}

/**
 * Codicon per runner, shown at the head of a group row so a package says how its
 * scripts will be launched before any of them is read — the same job the star
 * does for FAVORITES.
 *
 * Each is a property of the runner rather than its logo, since codicons carry no
 * brand marks: npm's registry package, yarn's zipped caches, pnpm's layered
 * content store, bun's speed, deno's web-standard runtime. They are meant to be
 * told apart at a glance, not recognised.
 */
const MANAGER_ICONS: Record<PackageManager, string> = {
  npm: 'package',
  yarn: 'archive',
  pnpm: 'layers',
  bun: 'zap',
  deno: 'globe',
};

/**
 * Icon for a group row. Every script in a group shares a manifest, so any one of
 * them resolves to the runner the whole group goes through — including a
 * `packageManager` override, which is what will really be executed.
 */
function groupIcon(script: ScriptEntry): string {
  return MANAGER_ICONS[resolvePackageManager(script)];
}

/** Highlighted part of a group row: the package's own name, or where it lives if it has none. */
function packageTitle(script: ScriptEntry): string {
  return script.packageName ?? (script.directory || path.posix.basename(script.manifest.path));
}

/**
 * Folder shown after the arrow on a group row: the directory the manifest lives
 * in, prefixed with the workspace folder when there is more than one. Empty when
 * there is nothing to add — a manifest in the root of a single-root workspace, or
 * a package with no `name`, whose title is already its location.
 */
function packageFolder(script: ScriptEntry): string {
  if (!script.packageName) {
    return '';
  }
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const folder = multiRoot ? vscode.workspace.getWorkspaceFolder(script.manifest) : undefined;
  return [folder?.name, script.directory].filter(Boolean).join('/');
}

/** Dimmed part of a group row: the manifest path relative to its workspace folder. */
function packagePath(script: ScriptEntry): string {
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const folder = vscode.workspace.getWorkspaceFolder(script.manifest);
  return multiRoot && folder ? `${folder.name}/${script.location}` : script.location;
}

/** Single-line form used by the quick pick, which has no rich labels. */
function packageLabel(script: ScriptEntry): string {
  const where = packagePath(script);
  return script.packageName ? `${script.packageName} — ${where}` : where;
}

// --- actions shared by the tree and the picker -------------------------------

function executionOf(node: TreeNode | undefined): vscode.TaskExecution | undefined {
  if (node?.kind === 'script') {
    return running.get(node.script.key);
  }
  return node?.kind === 'foreign' ? node.execution : undefined;
}

async function runNode(node: TreeNode | undefined): Promise<void> {
  if (node?.kind === 'script') {
    await startScript(node.script);
  }
}

async function stopNode(node: TreeNode | undefined): Promise<void> {
  const execution = executionOf(node);
  if (execution) {
    await stopExecution(execution);
  }
}

async function restartNode(node: TreeNode | undefined): Promise<void> {
  if (node?.kind === 'foreign') {
    const task = node.execution.task;
    await stopExecution(node.execution);
    await vscode.tasks.executeTask(task);
    return;
  }
  await stopNode(node);
  await runNode(node);
}

/** Stops everything the task system currently runs, ours and foreign alike. */
async function stopAllTasks(): Promise<void> {
  await Promise.all([...vscode.tasks.taskExecutions].map((execution) => stopExecution(execution)));
}

/** Restarts every running task. Unlike Refresh, this touches processes, not the script list. */
async function restartAllTasks(): Promise<void> {
  // Snapshot the tasks first: the executions are gone once they are terminated.
  const tasks = [...vscode.tasks.taskExecutions].map((execution) => execution.task);
  await stopAllTasks();
  for (const task of tasks) {
    await vscode.tasks.executeTask(task);
  }
}

async function toggleNode(node: TreeNode | undefined): Promise<void> {
  if (executionOf(node)) {
    await stopNode(node);
  } else {
    await runNode(node);
  }
}

// --- picker ------------------------------------------------------------------

interface ActionButton extends vscode.QuickInputButton {
  action: 'stop' | 'restart';
}

interface Item extends vscode.QuickPickItem {
  script?: ScriptEntry;
  /** Set for running tasks that do not come from a package.json. */
  execution?: vscode.TaskExecution;
}

const stopButton = (): ActionButton => ({
  action: 'stop',
  iconPath: new vscode.ThemeIcon('debug-stop'),
  tooltip: 'Stop',
});

const restartButton = (running: boolean): ActionButton => ({
  action: 'restart',
  iconPath: new vscode.ThemeIcon('debug-restart'),
  tooltip: running ? 'Restart' : 'Start',
});

interface ActivePicker {
  /** Repaints from the list already in hand — for a change of running state. */
  refresh(): void;
  /** Re-reads the manifests first — for a change to the manifests themselves. */
  reload(): Promise<void>;
  activeItem(): Item | undefined;
}

let activePicker: ActivePicker | undefined;

async function showScriptPicker(): Promise<void> {
  // Reassigned by `reload` when a manifest changes while the picker is open.
  let scripts = await collectScripts();

  if (scripts.length === 0 && runningCount() === 0) {
    vscode.window.showInformationMessage('No scripts found in any package.json of this workspace.');
    return;
  }

  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'package.json scripts';
  picker.placeholder = 'Enter — run / stop · Shift+Enter or ⟳ — restart';
  picker.matchOnDescription = true;

  const render = () => {
    const previous = picker.activeItems[0];
    picker.items = buildItems(scripts);
    const restored = picker.items.find(
      (item) =>
        (previous?.script && item.script?.key === previous.script.key) ||
        (previous?.execution && item.execution === previous.execution),
    );
    if (restored) {
      picker.activeItems = [restored];
    }
  };

  const reload = async () => {
    scripts = await collectScripts();
    render();
  };

  render();
  activePicker = { refresh: render, reload, activeItem: () => picker.activeItems[0] };
  void vscode.commands.executeCommand('setContext', CONTEXT_PICKER_OPEN, true);

  picker.onDidTriggerItemButton(async ({ item, button }) => {
    const action = (button as ActionButton).action;
    if (action === 'stop') {
      await stopNode(nodeOf(item));
    } else {
      await restartNode(nodeOf(item));
    }
    render();
  });

  picker.onDidAccept(async () => {
    const item = picker.activeItems[0];
    if (!item) {
      return;
    }
    if (item.script && !running.has(item.script.key)) {
      // Starting: hide so the task terminal is not covered by the picker.
      const script = item.script;
      picker.hide();
      await startScript(script);
      return;
    }
    await stopNode(nodeOf(item));
    render();
  });

  picker.onDidHide(() => {
    activePicker = undefined;
    void vscode.commands.executeCommand('setContext', CONTEXT_PICKER_OPEN, false);
    picker.dispose();
  });

  picker.show();
}

function buildItems(scripts: ScriptEntry[]): Item[] {
  const items: Item[] = [];
  const runningScripts = scripts.filter((script) => running.has(script.key));
  const foreign = foreignExecutions();
  const multiPackage = new Set(scripts.map((script) => script.manifest.toString())).size > 1;

  if (runningScripts.length > 0 || foreign.length > 0) {
    items.push({ label: `Running (${runningScripts.length + foreign.length})`, kind: vscode.QuickPickItemKind.Separator });

    for (const script of runningScripts) {
      items.push({
        label: `$(sync~spin) ${displayName(script)}`,
        description: scriptDescription(script),
        detail: multiPackage ? packageLabel(script) : undefined,
        buttons: [restartButton(true), stopButton()],
        script,
      });
    }

    for (const execution of foreign) {
      items.push({
        label: `$(sync~spin) ${execution.task.name}`,
        description: execution.task.source ? `${execution.task.source} task` : 'task',
        buttons: [restartButton(true), stopButton()],
        execution,
      });
    }
  }

  let currentGroup: string | undefined;
  for (const script of scripts) {
    if (running.has(script.key)) {
      continue;
    }
    const group = script.manifest.toString();
    if (multiPackage && group !== currentGroup) {
      currentGroup = group;
      items.push({ label: packageLabel(script), kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      // Quick pick labels take a codicon but no colour, so the category shows
      // through the glyph alone here.
      label: `$(${categoryFor(script)?.icon ?? 'play'}) ${displayName(script)}`,
      description: scriptDescription(script),
      buttons: [restartButton(false)],
      script,
    });
  }

  return items;
}

async function restartActiveItem(): Promise<void> {
  const item = activePicker?.activeItem();
  if (item) {
    await restartNode(nodeOf(item));
    activePicker?.refresh();
  }
}

/** Picker items and tree nodes describe the same things, so actions are shared. */
function nodeOf(item: Item): TreeNode | undefined {
  if (item.script) {
    return { kind: 'script', script: item.script };
  }
  return item.execution ? { kind: 'foreign', execution: item.execution } : undefined;
}

// --- running tasks -----------------------------------------------------------

async function startScript(script: ScriptEntry): Promise<void> {
  const execution = await vscode.tasks.executeTask(buildTask(script));
  running.set(script.key, execution);
  onStateChanged();
}

async function stopExecution(execution: vscode.TaskExecution): Promise<void> {
  const ended = waitForEnd(execution);
  execution.terminate();
  await ended;

  const key = keyForTask(execution.task);
  if (key) {
    running.delete(key);
  }
  onStateChanged();
}

/** Resolves when the execution ends, or after a grace period if no event arrives. */
function waitForEnd(execution: vscode.TaskExecution): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve();
    }, 3000);

    const subscription = vscode.tasks.onDidEndTask((event) => {
      if (event.execution === execution || sameTask(event.execution.task, execution.task)) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
}

function sameTask(a: vscode.Task, b: vscode.Task): boolean {
  return a.name === b.name && a.source === b.source && JSON.stringify(a.definition) === JSON.stringify(b.definition);
}

function buildTask(script: ScriptEntry): vscode.Task {
  const folder = vscode.workspace.getWorkspaceFolder(script.manifest);
  const dir = script.directory;
  const task = new vscode.Task(
    { type: TASK_TYPE, script: script.name, manifest: script.manifest.toString() },
    folder ?? vscode.TaskScope.Workspace,
    dir ? `${script.name} (${dir})` : script.name,
    TASK_SOURCE,
    new vscode.ShellExecution(commandFor(script), { cwd: script.cwd.fsPath }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    echo: true,
    focus: false,
    showReuseMessage: false,
  };
  return task;
}

function commandFor(script: ScriptEntry): string {
  return RUNNERS[resolvePackageManager(script)](quote(script.name));
}

// --- status bar & badge ------------------------------------------------------

let statusBarItem: vscode.StatusBarItem | undefined;

function syncStatusBar(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace
    .getConfiguration('taskRunnerUltimate')
    .get<boolean>('showInStatusBar', true);

  if (!enabled) {
    statusBarItem?.dispose();
    statusBarItem = undefined;
    return;
  }

  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'taskRunnerUltimate.show';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }

  updateStatusBar(runningCount());
}

function updateStatusBar(count: number): void {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = count > 0 ? `$(sync~spin) Task Runner ${count}` : '$(play-circle) Task Runner';
  statusBarItem.tooltip = count > 0 ? `${count} running task(s) — click to manage` : 'Show package.json scripts';
}

/** Command ids of the badge variants, index 0 being a count of 1. */
function badgeCommandIds(): string[] {
  const ids: string[] = [];
  for (let count = 1; count <= MAX_BADGE; count++) {
    ids.push(`taskRunnerUltimate.show.badge${count}`);
  }
  ids.push('taskRunnerUltimate.show.badgeMany');
  return ids;
}

// --- scanning ----------------------------------------------------------------

async function collectScripts(): Promise<ScriptEntry[]> {
  if (cache) {
    return cache;
  }

  const config = vscode.workspace.getConfiguration('taskRunnerUltimate');
  const exclude = config.get<string>('exclude') || '**/node_modules/**';
  const manifests = await vscode.workspace.findFiles(MANIFEST_GLOB, exclude, MAX_MANIFESTS);

  // Hitting the cap means the list on screen is incomplete, which is worth
  // saying out loud — once per window, not on every rescan.
  if (manifests.length === MAX_MANIFESTS && !warnedAboutTruncation) {
    warnedAboutTruncation = true;
    void vscode.window.showWarningMessage(
      `Task Runner Ultimate stopped after ${MAX_MANIFESTS} manifests, so some scripts are missing. ` +
        'Widen "taskRunnerUltimate.exclude" to skip the ones you do not need.',
    );
  }

  manifests.sort((a, b) => a.fsPath.length - b.fsPath.length || a.fsPath.localeCompare(b.fsPath));

  const entries: ScriptEntry[] = [];

  for (const manifest of manifests) {
    const isDenoTask = path.posix.basename(manifest.path) !== 'package.json';
    const manifestJson = await readManifest(manifest);
    // package.json keeps its scripts in "scripts", deno.json(c) in "tasks".
    const scripts = isDenoTask ? manifestJson?.tasks : manifestJson?.scripts;
    if (!scripts || typeof scripts !== 'object') {
      continue;
    }

    const cwd = manifest.with({ path: path.posix.dirname(manifest.path) });
    const folder = vscode.workspace.getWorkspaceFolder(manifest);
    const relative = folder ? path.relative(folder.uri.fsPath, manifest.fsPath) : manifest.fsPath;
    const location = relative.split(path.sep).join('/') || path.posix.basename(manifest.path);
    const directory = location.includes('/') ? location.slice(0, location.lastIndexOf('/')) : '';

    for (const [name, value] of Object.entries(scripts)) {
      const command = commandOf(value);
      if (command === undefined) {
        continue;
      }
      entries.push({
        key: scriptKey(manifest.toString(), name),
        name,
        command,
        manifest,
        isDenoTask,
        cwd,
        location,
        directory,
        packageName: typeof manifestJson.name === 'string' ? manifestJson.name : undefined,
      });
    }
  }

  cache = entries;
  await detectPackageManagers(entries);
  return entries;
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

async function readManifest(uri: vscode.Uri): Promise<any | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseJsonc(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** JSON.parse that tolerates comments and trailing commas, as deno.jsonc allows both. */
function parseJsonc(text: string): unknown {
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

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// --- package manager detection ----------------------------------------------

/** Package manager per package directory, detected while scanning. */
const detected = new Map<string, PackageManager>();

function resolvePackageManager(script: ScriptEntry): PackageManager {
  // A deno.json(c) task can only be run by Deno, so it ignores any override.
  if (script.isDenoTask) {
    return 'deno';
  }

  const configured = vscode.workspace
    .getConfiguration('taskRunnerUltimate', script.manifest)
    .get<string>('packageManager', 'auto');

  if (configured && configured !== 'auto') {
    return configured as PackageManager;
  }
  return detected.get(script.cwd.toString()) ?? 'npm';
}

async function detectPackageManagers(entries: ScriptEntry[]): Promise<void> {
  for (const entry of entries) {
    const dir = entry.cwd.toString();
    if (entry.isDenoTask || detected.has(dir)) {
      continue;
    }
    const found = await detectPackageManager(entry);
    if (found) {
      detected.set(dir, found);
    }
  }
}

async function detectPackageManager(entry: ScriptEntry): Promise<PackageManager | undefined> {
  const manifest = await readManifest(entry.manifest);

  // 1. An explicit "packageManager": "<name>@<version>" field wins.
  const field = typeof manifest?.packageManager === 'string' ? manifest.packageManager : '';
  const fromField = ENGINE_KEYS.find((manager) => field.startsWith(`${manager}@`));
  if (fromField) {
    return fromField;
  }

  // 2. Then the "engines" field, e.g. { "engines": { "pnpm": ">=9" } }.
  const engines = manifest?.engines;
  if (engines && typeof engines === 'object') {
    const fromEngines = ENGINE_KEYS.find((manager) => typeof engines[manager] === 'string');
    if (fromEngines) {
      return fromEngines;
    }
  }

  // 3. Finally lock and config files, nearest-first: the package itself, then
  //    each parent up to the workspace folder, where monorepo lock files live.
  const root = vscode.workspace.getWorkspaceFolder(entry.manifest)?.uri.path;
  let current = entry.cwd;
  while (true) {
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

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function quote(name: string): string {
  return /^[\w.:@/-]+$/.test(name) ? name : JSON.stringify(name);
}
