import * as path from 'path';
import * as vscode from 'vscode';
import {
  collectScripts,
  commandFor,
  groupIcon,
  resetSources,
  scriptKey,
  ScriptEntry,
  WATCH_GLOB,
} from './sources';

/** Task type used for the tasks this extension executes. Must match contributes.taskDefinitions. */
const TASK_TYPE = 'taskRunnerUltimate';
const TASK_SOURCE = 'scripts';
const CONTEXT_PICKER_OPEN = 'taskRunnerUltimate.pickerOpen';
const CONTEXT_RUNNING_COUNT = 'taskRunnerUltimate.runningCount';
/** Highest count with a dedicated badge icon; above this the "9+" icon is used. */
const MAX_BADGE = 9;

interface CategoryRule {
  /** Tokens the script name (or, as a last resort, its command) is matched against. */
  match: string[];
  /** Codicon id shown for scripts in this category. */
  icon: string;
  /** Theme colour id the icon is tinted with. */
  color: string;
}

/**
 * Built-in categories, checked in this order after any user-defined ones. The
 * tokens deliberately mix names and tools across every ecosystem the scan
 * covers: `run` is a cargo subcommand and a mise task, `pytest` and `vitest`
 * both mean "this is a test", and matching either the name or the command means
 * one rule covers both ways of saying it.
 */
const DEFAULT_CATEGORIES: ReadonlyArray<CategoryRule> = [
  {
    match: ['dev', 'run', 'start', 'serve', 'server', 'watch', 'preview', 'storybook', 'up', 'example'],
    icon: 'play',
    color: 'taskRunnerUltimate.category.run',
  },
  {
    match: [
      'test',
      'tests',
      'spec',
      'e2e',
      'jest',
      'vitest',
      'cypress',
      'playwright',
      'coverage',
      'pytest',
      'tox',
      'nox',
      'phpunit',
      'pest',
      'bench',
    ],
    icon: 'beaker',
    color: 'taskRunnerUltimate.category.test',
  },
  {
    match: [
      'lint',
      'format',
      'fmt',
      'prettier',
      'eslint',
      'stylelint',
      'typecheck',
      'tsc',
      'check',
      'clippy',
      'ruff',
      'black',
      'isort',
      'mypy',
      'flake8',
      'vet',
      'audit',
      'phpstan',
      'psalm',
      'pint',
    ],
    icon: 'law',
    color: 'taskRunnerUltimate.category.quality',
  },
  {
    match: ['build', 'compile', 'bundle', 'dist', 'prepack', 'prepare', 'install', 'wheel', 'sdist', 'doc', 'docs'],
    icon: 'package',
    color: 'taskRunnerUltimate.category.build',
  },
  {
    match: ['release', 'publish', 'deploy', 'version', 'changeset', 'twine', 'upload'],
    icon: 'rocket',
    color: 'taskRunnerUltimate.category.release',
  },
  {
    match: ['migrate', 'migration', 'migrations', 'seed', 'db', 'prisma', 'generate', 'codegen', 'alembic', 'sqlx'],
    icon: 'database',
    color: 'taskRunnerUltimate.category.data',
  },
  {
    match: ['clean', 'clear', 'reset', 'rimraf', 'purge', 'tidy', 'update'],
    icon: 'trash',
    color: 'taskRunnerUltimate.category.clean',
  },
];

/** Settings a scan reads, so a change to one has to throw the cached list away. */
const SCAN_SETTINGS = ['exclude', 'sources', 'cargoCommands', 'goCommands', 'pythonRunner'];
/** Settings that only change how the list is drawn — no rescan, just a repaint. */
const DISPLAY_SETTINGS = ['packageManager', 'categories', 'colorIcons'];

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
  resetSources();
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
      vscode.window.setStatusBarMessage('Task Runner Manager: reloaded', 2000);
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
      // Anything that decides which manifests are read, or what is read out of
      // them, needs the scan done again; the rest only changes how what we
      // already have is drawn.
      if (SCAN_SETTINGS.some((key) => event.affectsConfiguration(`taskRunnerUltimate.${key}`))) {
        invalidate();
      } else if (DISPLAY_SETTINGS.some((key) => event.affectsConfiguration(`taskRunnerUltimate.${key}`))) {
        repaint();
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
 * Highlighted part of a group row: the package's own name, or the manifest's
 * file name when it does not name one.
 *
 * The file name rather than the directory, because a directory can hold several
 * manifests — a Cargo.toml beside a Makefile beside a justfile is an ordinary
 * Rust repository — and three groups all titled after the same folder would say
 * nothing about which is which.
 */
function packageTitle(script: ScriptEntry): string {
  return script.packageName ?? path.posix.basename(script.manifest.path);
}

/**
 * Folder shown after the arrow on a group row: the directory the manifest lives
 * in, prefixed with the workspace folder when there is more than one. Empty for
 * a manifest in the root of a single-root workspace, where there is nothing to
 * add that the title has not already said.
 */
function packageFolder(script: ScriptEntry): string {
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
    vscode.window.showInformationMessage('No tasks found in any manifest of this workspace.');
    return;
  }

  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'Workspace tasks';
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

const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });

/**
 * The tree's shape, flattened into separators and rows: FAVORITES, then the
 * tasks that came from outside a manifest, then one block per package — the
 * packages with something running first, and inside each of them the running
 * scripts first. Two surfaces showing the same list in two different orders is
 * two things to learn instead of one.
 *
 * It departs from the tree in one place. The tree lists a starred script twice,
 * in FAVORITES and in its own package, because the two rows sit in different
 * collapsible groups; flattened, that reads as a duplicate. So here a script has
 * exactly one row, and a starred one is lifted out of its package — its
 * FAVORITES row names the package instead, which is what the tree does too.
 */
function buildItems(scripts: ScriptEntry[]): Item[] {
  const items: Item[] = [];
  const foreign = foreignExecutions();
  const multiPackage = new Set(scripts.map((script) => script.manifest.toString())).size > 1;

  const favorites = favoriteScripts(scripts);
  const starred = new Set(favorites.map((script) => script.key));

  if (favorites.length > 0) {
    items.push(separator(`Favorites (${favorites.length})`));
    for (const script of favorites) {
      items.push(scriptItem(script, true));
    }
  }

  if (foreign.length > 0) {
    items.push(separator(`Other tasks (${foreign.length})`));
    for (const execution of foreign) {
      items.push({
        label: `$(sync~spin) ${execution.task.name}`,
        description: execution.task.source ? `${execution.task.source} task` : 'task',
        buttons: [restartButton(true), stopButton()],
        execution,
      });
    }
  }

  // One block per package, keeping the order the scan produced.
  const blocks = new Map<string, { label: string; running: Item[]; idle: Item[] }>();
  for (const script of scripts) {
    if (starred.has(script.key)) {
      continue;
    }
    const key = script.manifest.toString();
    let block = blocks.get(key);
    if (!block) {
      block = { label: packageLabel(script), running: [], idle: [] };
      blocks.set(key, block);
    }
    (running.has(script.key) ? block.running : block.idle).push(scriptItem(script, false));
  }

  // A separator is the only thing that closes the block above it off, so package
  // headings appear as soon as there is anything above them — including in a
  // single-package workspace, where on their own they would be pure noise.
  const headings = multiPackage || items.length > 0;
  const ordered = [...blocks.values()];

  for (const block of [...ordered.filter((b) => b.running.length > 0), ...ordered.filter((b) => b.running.length === 0)]) {
    if (headings) {
      items.push(separator(block.label));
    }
    items.push(...block.running, ...block.idle);
  }

  return items;
}

/**
 * One script row. Under Favorites it also says which package it came from, the
 * same way the tree's FAVORITES rows do — listed away from a package heading,
 * the row has to answer that itself.
 *
 * The icon is written into the label as `$(id)` rather than passed as `iconPath`,
 * which looks like the worse of the two and is not:
 *
 * - `iconPath` puts the icon in the row's own 16px slot, which carries
 *   `padding-right: 6px`. A codicon lands centred in the content box while
 *   `transform: rotate()` turns about the border box, so `sync~spin` orbits its
 *   own centre by 3px instead of spinning on it. That CSS belongs to VS Code and
 *   an extension cannot reach it.
 * - The colour is dropped either way. VS Code converts a `ThemeIcon` to a bare
 *   codicon class on the way into a quick pick and loses the `ThemeColor` doing
 *   it — `mainThreadQuickOpen.ts` carries a TODO saying exactly that. Only URI
 *   icons are drawn in colour there, and a pre-rendered SVG cannot resolve a
 *   theme colour id, least of all one a user put in `categories`.
 *
 * So `iconPath` costs the spinner and buys nothing. In the label the codicon is
 * an inline span sized to the glyph, and it spins true.
 */
function scriptItem(script: ScriptEntry, inFavorites: boolean): Item {
  const isRunning = running.has(script.key);
  const icon = isRunning ? 'sync~spin' : categoryFor(script)?.icon ?? 'play';
  return {
    label: `$(${icon}) ${displayName(script)}`,
    description: scriptDescription(script, inFavorites),
    buttons: isRunning ? [restartButton(true), stopButton()] : [restartButton(false)],
    script,
  };
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
  // A directory can hold a package.json, a Makefile and a justfile, each with a
  // `test`, so what disambiguates the terminal's name is the manifest and not
  // just the directory — except for a Node package, where the file name is
  // always package.json and would only be noise.
  const where = script.kind === 'npm' || script.kind === 'deno' ? script.directory : script.location;
  const task = new vscode.Task(
    { type: TASK_TYPE, script: script.name, manifest: script.manifest.toString() },
    folder ?? vscode.TaskScope.Workspace,
    where ? `${script.name} (${where})` : script.name,
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
  statusBarItem.tooltip = count > 0 ? `${count} running task(s) — click to manage` : 'Show workspace tasks';
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
