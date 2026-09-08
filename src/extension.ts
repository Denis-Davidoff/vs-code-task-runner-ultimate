import * as path from 'path';
import * as vscode from 'vscode';
import { locateTask } from './locate';
import {
  collectScripts,
  commandFor,
  launchArgv,
  plainArgument,
  resetSources,
  scriptKey,
  ScriptEntry,
  SOURCE_GLOB,
  WATCH_GLOB,
} from './sources';

/** Task type used for the tasks this extension executes. Must match contributes.taskDefinitions. */
const TASK_TYPE = 'taskRunnerUltimate';
const TASK_SOURCE = 'scripts';
const CONTEXT_PICKER_OPEN = 'taskRunnerUltimate.pickerOpen';
const CONTEXT_RUNNING_COUNT = 'taskRunnerUltimate.runningCount';

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
const DISPLAY_SETTINGS = ['packageManager', 'categories', 'colorIcons', 'pinRunningTasks'];

/**
 * The heading the two views wear until the `title` setting says otherwise. The
 * same string as the `name` in contributes.views, which is what VS Code draws
 * before the extension has had a chance to say anything.
 */
const DEFAULT_TITLE = 'Task & Script Explorer';
/** Longest heading accepted, matching the `maxLength` in the setting's schema. */
const TITLE_LIMIT = 100;

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

/** How long a burst of file events is given to settle before the list is rebuilt. */
const INVALIDATE_DELAY = 150;
let invalidateTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * `invalidate`, once a burst of file events has stopped.
 *
 * A branch switch, an `npm install`, a `cargo new` — anything that touches
 * several watched files at once — arrives as a run of events, and each one on
 * its own drops the cache, abandons the scan the event before it started, and
 * asks for another. Bumping the generation mid-scan is what makes that waste
 * real rather than merely repeated: the work already done is thrown away. One
 * rescan after the last event of the run is the same answer for a fraction of
 * it.
 *
 * Only the filesystem goes through this. A person pressing Refresh, or changing
 * a setting that decides what is scanned, gets the rescan straight away — the
 * cost of a wait there is felt, and there is no burst to collapse.
 */
function invalidateSoon(): void {
  clearTimeout(invalidateTimer);
  invalidateTimer = setTimeout(() => {
    invalidateTimer = undefined;
    invalidate();
  }, INVALIDATE_DELAY);
}

/** Drops a rescan that has been scheduled but not run — for `deactivate`. */
function cancelInvalidate(): void {
  clearTimeout(invalidateTimer);
  invalidateTimer = undefined;
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
  // The settings entry in the menu filters the settings editor by this id, and
  // reading it off the context is what keeps it right if the publisher changes.
  // `ExtensionContext.extension` is stable API as of VS Code 1.62, well under the
  // 1.85 this extension asks for, so there is no id spelled out anywhere here.
  extensionId = context.extension.id;

  for (const exec of vscode.tasks.taskExecutions) {
    const key = keyForTask(exec.task);
    if (key) {
      running.set(key, exec);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('taskRunnerUltimate.show', showScriptPicker),
    vscode.commands.registerCommand('taskRunnerUltimate.restartActive', restartActiveItem),
    vscode.commands.registerCommand('taskRunnerUltimate.refresh', refreshScripts),
    // The buttons on a row start a task without pulling the terminal to the
    // front; clicking the row itself is the one that also shows it. See
    // `startScript`.
    //
    // `toggleItem` keeps its id — a row click is bound to it and so may a user's
    // keybinding be — but no longer toggles: see `activateNode`.
    vscode.commands.registerCommand('taskRunnerUltimate.runItem', (node?: TreeNode) => runNode(node, false)),
    vscode.commands.registerCommand('taskRunnerUltimate.stopItem', (node?: TreeNode) => stopNode(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.restartItem', (node?: TreeNode) => restartNode(node, false)),
    vscode.commands.registerCommand('taskRunnerUltimate.toggleItem', (node?: TreeNode) => activateNode(node, true)),
    // The same two actions again under their own ids, for the context menu. A
    // menu entry takes its label from the command, and these labels carry the
    // mouse gesture that does the same thing — "Run (Click)", "Stop
    // (Double-Click)" — which the inline ▶ and ■ tooltips must not say, since a
    // button is pressed, not clicked twice. Run reveals the terminal here
    // because that is what the click it is named after does.
    vscode.commands.registerCommand('taskRunnerUltimate.runItemMenu', (node?: TreeNode) => runNode(node, true)),
    vscode.commands.registerCommand('taskRunnerUltimate.stopItemMenu', (node?: TreeNode) => stopNode(node)),
    // Two ids for one action: a menu entry takes its label from the command, and
    // "the task" and "the manifest" are two different things to promise.
    vscode.commands.registerCommand('taskRunnerUltimate.openScript', (node?: TreeNode) => openManifest(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.openManifest', (node?: TreeNode) => openManifest(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.showTerminal', (node?: TreeNode) => showTerminal(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.openTerminalEditor', (node?: TreeNode) =>
      openTerminalEditor(node),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.addFavorite', (node?: TreeNode) => setFavorite(node, true)),
    vscode.commands.registerCommand('taskRunnerUltimate.removeFavorite', (node?: TreeNode) => setFavorite(node, false)),
    // The two halves of one toggle. Two ids rather than one, for the same reason
    // the star has two: a menu entry takes its label from the command, and the
    // row has to say which way pressing it goes.
    vscode.commands.registerCommand('taskRunnerUltimate.addConfirmation', (node?: TreeNode) =>
      setConfirmation(node, true),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.removeConfirmation', (node?: TreeNode) =>
      setConfirmation(node, false),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.editTitle', (node?: TreeNode) => editTitle(node)),
    // The two eyes on a package heading, one edit to one group each, so they take
    // the row they were clicked on and nothing else. Reordering has no command of
    // its own: a heading is moved by dragging it, which is the gesture the rows
    // inside it already answer to.
    vscode.commands.registerCommand('taskRunnerUltimate.hideGroup', (node?: TreeNode) => setGroupHidden(node, true)),
    vscode.commands.registerCommand('taskRunnerUltimate.showGroup', (node?: TreeNode) => setGroupHidden(node, false)),
    // The stop and restart on a heading, offered only while something under it
    // runs. They act on the group's running rows and nothing else — an idle
    // script is not started by restarting its neighbours.
    vscode.commands.registerCommand('taskRunnerUltimate.stopGroup', (node?: TreeNode) => stopGroup(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.restartGroup', (node?: TreeNode) => restartGroup(node)),
    // One command per colour: a submenu entry is a command, and there is no way
    // to hand it an argument from contributes.menus. The list is the palette's,
    // so the two can never drift apart.
    ...PALETTE.map((name) =>
      vscode.commands.registerCommand(`taskRunnerUltimate.setColor.${name}`, (node?: TreeNode) =>
        setNodeColor(node, name),
      ),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.clearColor', (node?: TreeNode) =>
      setNodeColor(node, undefined),
    ),
    // One command for every icon, unlike the colours: an icon picker is a list
    // of thirty, which is a quick pick's size and three columns past a submenu's.
    vscode.commands.registerCommand('taskRunnerUltimate.pickIcon', (node?: TreeNode) => pickIcon(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.menu', showMenu),
    vscode.commands.registerCommand('taskRunnerUltimate.stopAll', stopAllTasks),
    vscode.commands.registerCommand('taskRunnerUltimate.restartAll', restartAllTasks),
    vscode.tasks.registerTaskProvider(TASK_TYPE, {
      provideTasks: async () => (await collectScripts()).map((script) => buildTask(script)),
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
  // The events carry the changed URI, which `invalidate` has no use for, and
  // they arrive in runs, which is what `invalidateSoon` is for.
  watcher.onDidChange(() => invalidateSoon());
  watcher.onDidCreate(() => invalidateSoon());
  watcher.onDidDelete(() => invalidateSoon());

  // The files that are a row by being there at all — see `SOURCE_GLOB`. Changes
  // to what is inside them are ignored, which is the third argument: a crate
  // gains and loses a `run` row by gaining and losing its `src/main.rs`, and
  // rescans nothing while it is being written.
  const sourceWatcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB, false, true, false);
  sourceWatcher.onDidCreate(() => invalidateSoon());
  sourceWatcher.onDidDelete(() => invalidateSoon());

  context.subscriptions.push(
    watcher,
    sourceWatcher,
    // A rescan waiting on its timer must not outlive the extension.
    { dispose: cancelInvalidate },
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
      if (event.affectsConfiguration('taskRunnerUltimate.title')) {
        syncTitles();
      }
    }),
  );

  syncStatusBar(context);
  onStateChanged();
}

export function deactivate(): void {
  cancelInvalidate();
  running.clear();
  clearHint();
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
  void vscode.commands.executeCommand('setContext', CONTEXT_RUNNING_COUNT, count);
  updateStatusBar(count);
  activePicker?.refresh();
  treeChanged.fire();
  // Both views carry the badge: the count belongs to the tasks, not to the
  // sidebar the list happens to be read in.
  const badge = count > 0 ? { value: count, tooltip: `${count} running task(s)` } : undefined;
  for (const view of [treeView, explorerTreeView]) {
    if (view) {
      view.badge = badge;
    }
  }
}

/**
 * The heading over the list: whatever the user called it, or the extension's own
 * name.
 *
 * The bounds are enforced here as well as declared in the setting's schema. A
 * settings.json edited by hand is only warned about, so the value still arrives:
 * an empty heading would leave the section with nothing to read or click on, and
 * a hundred characters is already more than the header row can show before the
 * badge and the buttons are pushed off it.
 */
function viewTitle(): string {
  // Read as `unknown` and typed here: a schema is what the settings editor
  // enforces, not what `get` returns, and a heading that is a number by mistake
  // would otherwise throw on its way to being trimmed — during activation.
  const configured = vscode.workspace.getConfiguration('taskRunnerUltimate').get<unknown>('title');
  const text = typeof configured === 'string' ? configured.trim() : '';
  // Cut by code points rather than by `slice`, which counts UTF-16 units and
  // would leave half an emoji behind at the boundary.
  return text ? Array.from(text).slice(0, TITLE_LIMIT).join('') : DEFAULT_TITLE;
}

/**
 * Puts that heading on both views. The activity bar container keeps the name it
 * was installed with — a container's title is read from the manifest once and
 * there is no API to change it — so what a rename reaches is the section header
 * inside the sidebar, in the activity bar and in the File Explorer alike.
 */
function syncTitles(): void {
  const title = viewTitle();
  for (const view of [treeView, explorerTreeView]) {
    if (view) {
      view.title = title;
    }
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
 * The trade-off is that neither travels: a second machine starts with nothing
 * starred, and a team cannot share a list. Moving either to a setting would buy
 * that at the cost of rewriting settings.json on every click of a star.
 */
const FAVORITES_KEY = 'favorites';
const TITLES_KEY = 'titles';
const ORDER_KEY = 'order';
const GROUP_ORDER_KEY = 'groupOrder';
const COLLAPSED_KEY = 'collapsed';
const COLORS_KEY = 'colors';
const ICONS_KEY = 'icons';
const CONFIRM_KEY = 'confirmations';

let storage: vscode.Memento | undefined;
/** This extension's `publisher.name`, for the query that filters the settings editor. */
let extensionId: string | undefined;

/**
 * Storage identity of the group a script belongs to — its manifest, named the
 * way the workspace sees it, e.g. `my-app/packages/api/package.json`. Doubles as
 * the scope a drag is allowed to move a script inside of.
 */
function groupRef(script: ScriptEntry): string {
  const folder = vscode.workspace.getWorkspaceFolder(script.manifest);
  return folder ? `${folder.name}/${script.location}` : script.manifest.toString();
}

/**
 * Storage identity of a script — the group it belongs to plus its name,
 * e.g. `my-app/packages/api/package.json::dev`. Deliberately not the absolute
 * URI `ScriptEntry.key` uses: that one is rebuilt on every scan and is fine as a
 * runtime handle, but a workspace moved to another path on disk would lose all
 * of its favorites.
 */
function scriptRef(script: ScriptEntry): string {
  return `${groupRef(script)}::${script.name}`;
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

// --- run confirmations -------------------------------------------------------

/**
 * The tasks that ask before they start or stop.
 *
 * A toggle on the row rather than a setting, because what wants a second thought
 * is one `deploy` among forty and naming it in settings.json would mean spelling
 * out a ref nobody ever sees. Stored as a list of script refs, the favorites'
 * shape: being in the list is the "on", and there is no "off" entry to keep.
 *
 * Only a script row can carry one. A package heading runs nothing of its own, and
 * a foreign task is somebody else's execution, alive only while it runs, so
 * neither has anything stable to file a flag against.
 */
function confirmRefs(): string[] {
  const stored = storage?.get<unknown>(CONFIRM_KEY);
  return Array.isArray(stored) ? stored.filter((ref): ref is string => typeof ref === 'string') : [];
}

function needsConfirmation(script: ScriptEntry): boolean {
  return confirmRefs().includes(scriptRef(script));
}

/** The two halves of the toggle in the context menu, one command each. */
async function setConfirmation(node: TreeNode | undefined, on: boolean): Promise<void> {
  if (node?.kind !== 'script') {
    return;
  }
  const ref = scriptRef(node.script);
  const refs = confirmRefs().filter((item) => item !== ref);
  if (on) {
    refs.push(ref);
  }
  await storage?.update(CONFIRM_KEY, refs);
  repaint();
}

/**
 * What the dialog says, per action. Restart is its own entry rather than a run
 * asked after a stop: one gesture is one question, and a row that asked twice
 * would be a row nobody restarts.
 */
const CONFIRM_ACTIONS = {
  run: { button: 'Run', detail: 'This task asks before it starts.' },
  stop: { button: 'Stop', detail: 'This task asks before it stops.' },
  restart: { button: 'Restart', detail: 'This task asks before it stops and starts again.' },
} as const;

type ConfirmAction = keyof typeof CONFIRM_ACTIONS;

/**
 * Whether the action may go ahead: straight through for a row with no
 * confirmation on it, and after a modal for one that has.
 *
 * Only the actions aimed at a single row ask. Stop All, and the stop and restart
 * on a package heading, are already the deliberate gesture the flag exists to
 * make you perform — a dialog per row there would turn one decision into ten.
 */
async function confirmScript(script: ScriptEntry, action: ConfirmAction): Promise<boolean> {
  if (!needsConfirmation(script)) {
    return true;
  }
  const { button, detail } = CONFIRM_ACTIONS[action];
  const answer = await vscode.window.showWarningMessage(
    `${button} "${displayName(script)}"?`,
    { modal: true, detail: `${detail} Turn that off with "Remove Confirmation" in its context menu.` },
    button,
  );
  return answer === button;
}

function customTitles(): Record<string, string> {
  const stored = storage?.get<unknown>(TITLES_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, string>)
    : {};
}

/**
 * The user's title for a ref, if it has one. Scripts and group headings share
 * one store: a group's ref is its manifest and a script's is that same ref plus
 * `::name`, so the two can never collide, and one "Reset all titles" undoes
 * both rather than making the menu carry two entries that mean the same thing.
 */
function storedTitle(ref: string): string | undefined {
  const title = customTitles()[ref];
  return typeof title === 'string' && title ? title : undefined;
}

function customTitle(script: ScriptEntry): string | undefined {
  return storedTitle(scriptRef(script));
}

/** The user's title for the group a script sits in — the heading, not the row. */
function customGroupTitle(script: ScriptEntry): string | undefined {
  return storedTitle(groupRef(script));
}

/** What the lists show for a script: the user's title if it has one, else its name. */
function displayName(script: ScriptEntry): string {
  return customTitle(script) ?? script.name;
}

/** The rename dialog, for a script row and for a group heading alike. */
async function editTitle(node: TreeNode | undefined): Promise<void> {
  if (node?.kind === 'group') {
    // The foreign-task and hidden groups are labels of ours, not names read off
    // disk, so they carry no ref and there is nothing to restore a rename to.
    await renameRef(node.ref, node.label, 'package');
  } else if (node?.kind === 'script') {
    await renameRef(scriptRef(node.script), node.script.name, 'task');
  }
}

/**
 * Opens the manifest behind a row: a task row at the line the task is written
 * on, a package heading at the top of the file it names.
 *
 * A heading is a manifest and nothing else — it has no line of its own to point
 * at, and the top of the file is where you start reading one anyway. The two
 * rows are one action for the same reason they are one file: what differs is
 * where the cursor lands, not what is opened.
 *
 * A task's line is found now rather than remembered from the scan: see
 * `locateTask`. A task that has no line to point at — a cargo or go row, which
 * is a subcommand this extension offers and not an entry anyone wrote — opens
 * its manifest at the top, as a heading does.
 *
 * Opened as a real editor rather than a preview tab: this is the "go and edit
 * it" action, and a preview tab is the one that disappears the moment you open
 * anything else.
 */
async function openManifest(node: TreeNode | undefined): Promise<void> {
  // OTHER TASKS and HIDDEN are groups of ours rather than files, and carry no
  // manifest — the `when` clauses keep them out of the menu, and this keeps them
  // out of the command.
  const source: { file: vscode.Uri; where: string; task?: ScriptEntry } | undefined =
    node?.kind === 'script'
      ? { file: node.script.manifest, where: node.script.location, task: node.script }
      : node?.kind === 'group' && node.manifest
        ? { file: node.manifest, where: node.detail ?? node.manifest.fsPath }
        : undefined;
  if (!source) {
    return;
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(source.file);
  } catch {
    // The manifest has been deleted or renamed since the scan; the list is
    // stale rather than wrong, so say what happened and refresh it.
    void vscode.window.showWarningMessage(`Cannot open ${source.where}.`);
    await refreshScripts();
    return;
  }

  const found = source.task
    ? locateTask(document.getText(), source.task.kind, source.task.name)
    : undefined;
  const position = found
    ? new vscode.Position(found.line, found.character)
    : new vscode.Position(0, 0);
  const selection = new vscode.Range(
    position,
    found ? position.translate(0, found.length) : position,
  );

  const editor = await vscode.window.showTextDocument(document, { preview: false, selection });
  // showTextDocument scrolls the selection into view at the edge it came in
  // from; centring it puts the task in the middle of the file you are now
  // reading, with its neighbours around it.
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Why a rename is display-only, said in the terms of the row it was invoked on. */
const RENAME_PROMPT = {
  task: 'Shown in this list only — the task in the manifest keeps its name. Leave empty to restore it.',
  package: 'Shown in this list only — the manifest and its folder are not renamed. Leave empty to restore it.',
};

/**
 * Renames a row for display only. Nothing on disk is touched: a task's name is
 * what the package manager is asked to run, and a heading's name is a file or a
 * directory the project owns — rewriting either would break the task or force a
 * change to a file the user did not ask us to edit.
 *
 * Storing the original as a title is the same as having none, so a title equal
 * to it deletes the entry: it leaves no dead row in the menu's count, and a
 * later edit to the manifest is then followed rather than shadowed.
 */
async function renameRef(
  ref: string | undefined,
  original: string,
  subject: keyof typeof RENAME_PROMPT,
): Promise<void> {
  if (!ref) {
    return;
  }
  const entered = await vscode.window.showInputBox({
    title: `Rename "${original}"`,
    prompt: RENAME_PROMPT[subject],
    value: storedTitle(ref) ?? original,
    placeHolder: original,
  });
  if (entered === undefined) {
    return;
  }

  const titles = { ...customTitles() };
  const title = entered.trim();
  if (title && title !== original) {
    titles[ref] = title;
  } else {
    delete titles[ref];
  }
  await storage?.update(TITLES_KEY, titles);
  repaint();
}

// --- row colours -------------------------------------------------------------

/**
 * The ten colours a row can be painted, in the order the submenu offers them:
 * around the wheel from red, then the two quiet ones — brown and grey — last,
 * which is where a row being turned down rather than picked out belongs.
 *
 * The store keeps these names rather than the theme colour ids behind them. A
 * name is what the user picked, and the id it maps to stays ours to move; a
 * store full of ids is one that goes blank the day one of them is renamed. It is
 * also what lets a name this build no longer offers be ignored rather than
 * handed to `ThemeColor` as a colour nothing declares.
 */
const PALETTE = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray'] as const;

type PaletteName = (typeof PALETTE)[number];

/** The theme colour a palette name paints with, declared in contributes.colors. */
function paletteColor(name: PaletteName): string {
  return `taskRunnerUltimate.palette.${name}`;
}

function customColors(): Record<string, string> {
  const stored = storage?.get<unknown>(COLORS_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, string>)
    : {};
}

/**
 * The colour a ref was painted, if it still names one this build offers. Scripts
 * and group headings share the store the way they share the titles one — their
 * refs cannot collide, and one "Reset all colours" undoes both.
 */
function storedColor(ref: string | undefined): PaletteName | undefined {
  const name = ref ? customColors()[ref] : undefined;
  return PALETTE.find((entry) => entry === name);
}

/**
 * What a row's colour is filed under: the ref its title is, and for the two
 * groups that have no title to rename, the id they are built with.
 *
 * That is where colour parts company with the rename. A rename needs a name on
 * disk to put back, so OTHER TASKS cannot have one; a colour needs nothing but a
 * row to sit on, and that one is as worth finding at a glance as any package is.
 * Its id is a constant of ours — `group:foreign` — so a colour on it survives
 * everything a scan can change.
 *
 * The same fallback `collapseRef` uses, and for the same reason. Package groups
 * always carry a ref, so it is only ever that one that reaches the id.
 */
function colorRef(node: TreeNode): string | undefined {
  if (node.kind === 'group') {
    return node.ref ?? node.id;
  }
  // A foreign task is somebody else's execution, alive only while it runs, so
  // there is nothing stable to file a colour against.
  return node.kind === 'script' ? scriptRef(node.script) : undefined;
}

/** The theme colour a row is painted with, or nothing if it was never painted. */
function nodeColor(node: TreeNode): string | undefined {
  const name = storedColor(colorRef(node));
  return name ? paletteColor(name) : undefined;
}

/**
 * Paints a row, or strips it back to the colour it would have had. `undefined`
 * deletes the entry rather than storing a "default": an absent ref is what the
 * fallbacks already read as, and it keeps the menu's count honest about how much
 * there is to undo.
 */
async function setNodeColor(node: TreeNode | undefined, name: PaletteName | undefined): Promise<void> {
  const ref = node ? colorRef(node) : undefined;
  if (!ref) {
    return;
  }
  const colors = { ...customColors() };
  if (name) {
    colors[ref] = name;
  } else {
    delete colors[ref];
  }
  await storage?.update(COLORS_KEY, colors);
  repaint();
}

// --- row icons -----------------------------------------------------------------

/**
 * The icons a row can be given from its context menu, offered in a quick pick
 * rather than a submenu: a hundred entries is a list you filter, not a menu you
 * read. Every id is a codicon that has shipped for years, so the set is safe on
 * the 1.85 baseline this extension asks for — the one hard limit on growing the
 * list is that an id the running build's icon font does not carry draws as an
 * empty square, so nothing lands here without being in the font by then.
 *
 * The store keeps the codicon id, and `storedIcon` checks it against this list
 * the way `storedColor` checks the palette: an id a later build no longer offers
 * is ignored rather than handed to `ThemeIcon` as a glyph nothing draws.
 */
const ICON_GROUPS: ReadonlyArray<{ label: string; icons: ReadonlyArray<{ id: string; name: string }> }> = [
  {
    label: 'Actions & status',
    icons: [
      { id: 'rocket', name: 'Rocket' },
      { id: 'zap', name: 'Zap' },
      { id: 'flame', name: 'Flame' },
      { id: 'play-circle', name: 'Play' },
      { id: 'stop-circle', name: 'Stop' },
      { id: 'record', name: 'Record' },
      { id: 'check', name: 'Check' },
      { id: 'checklist', name: 'Checklist' },
      { id: 'sync', name: 'Sync' },
      { id: 'refresh', name: 'Refresh' },
      { id: 'save', name: 'Save' },
      { id: 'search', name: 'Search' },
      { id: 'filter', name: 'Filter' },
      { id: 'edit', name: 'Edit' },
      { id: 'trash', name: 'Trash' },
      { id: 'warning', name: 'Warning' },
      { id: 'error', name: 'Error' },
      { id: 'info', name: 'Info' },
      { id: 'question', name: 'Question' },
      { id: 'verified', name: 'Verified' },
      { id: 'history', name: 'History' },
      { id: 'watch', name: 'Watch' },
      { id: 'target', name: 'Target' },
      { id: 'pulse', name: 'Pulse' },
      { id: 'mute', name: 'Mute' },
    ],
  },
  {
    label: 'Objects',
    icons: [
      { id: 'star-full', name: 'Star' },
      { id: 'heart', name: 'Heart' },
      { id: 'bookmark', name: 'Bookmark' },
      { id: 'tag', name: 'Tag' },
      { id: 'pinned', name: 'Pin' },
      { id: 'key', name: 'Key' },
      { id: 'lock', name: 'Lock' },
      { id: 'unlock', name: 'Unlock' },
      { id: 'shield', name: 'Shield' },
      { id: 'bell', name: 'Bell' },
      { id: 'lightbulb', name: 'Lightbulb' },
      { id: 'gift', name: 'Gift' },
      { id: 'briefcase', name: 'Briefcase' },
      { id: 'calendar', name: 'Calendar' },
      { id: 'credit-card', name: 'Credit Card' },
      { id: 'inbox', name: 'Inbox' },
      { id: 'mail', name: 'Mail' },
      { id: 'megaphone', name: 'Megaphone' },
      { id: 'mirror', name: 'Mirror' },
      { id: 'paintcan', name: 'Paint Can' },
      { id: 'law', name: 'Law' },
      { id: 'jersey', name: 'Jersey' },
      { id: 'ruby', name: 'Ruby' },
      { id: 'mortar-board', name: 'Mortar Board' },
      { id: 'telescope', name: 'Telescope' },
      { id: 'compass', name: 'Compass' },
      { id: 'location', name: 'Location' },
      { id: 'link', name: 'Link' },
      { id: 'milestone', name: 'Milestone' },
      { id: 'smiley', name: 'Smiley' },
      { id: 'thumbsup', name: 'Thumbs Up' },
      { id: 'thumbsdown', name: 'Thumbs Down' },
      { id: 'eye', name: 'Eye' },
      { id: 'home', name: 'Home' },
    ],
  },
  {
    label: 'Dev & infrastructure',
    icons: [
      { id: 'bug', name: 'Bug' },
      { id: 'beaker', name: 'Beaker' },
      { id: 'tools', name: 'Tools' },
      { id: 'wrench', name: 'Wrench' },
      { id: 'gear', name: 'Gear' },
      { id: 'terminal', name: 'Terminal' },
      { id: 'code', name: 'Code' },
      { id: 'debug', name: 'Debug' },
      { id: 'extensions', name: 'Extensions' },
      { id: 'database', name: 'Database' },
      { id: 'server', name: 'Server' },
      { id: 'server-environment', name: 'Server Environment' },
      { id: 'server-process', name: 'Server Process' },
      { id: 'cloud', name: 'Cloud' },
      { id: 'cloud-upload', name: 'Cloud Upload' },
      { id: 'cloud-download', name: 'Cloud Download' },
      { id: 'globe', name: 'Globe' },
      { id: 'plug', name: 'Plug' },
      { id: 'circuit-board', name: 'Circuit Board' },
      { id: 'vm', name: 'Virtual Machine' },
      { id: 'dashboard', name: 'Dashboard' },
      { id: 'graph', name: 'Graph' },
      { id: 'graph-line', name: 'Graph Line' },
      { id: 'pie-chart', name: 'Pie Chart' },
      { id: 'layers', name: 'Layers' },
      { id: 'symbol-event', name: 'Event' },
      { id: 'radio-tower', name: 'Radio Tower' },
      { id: 'hubot', name: 'Robot' },
    ],
  },
  {
    label: 'Files & folders',
    icons: [
      { id: 'package', name: 'Package' },
      { id: 'archive', name: 'Archive' },
      { id: 'file', name: 'File' },
      { id: 'file-code', name: 'File Code' },
      { id: 'file-media', name: 'File Media' },
      { id: 'file-binary', name: 'File Binary' },
      { id: 'folder', name: 'Folder' },
      { id: 'folder-opened', name: 'Folder Opened' },
      { id: 'notebook', name: 'Notebook' },
      { id: 'book', name: 'Book' },
      { id: 'library', name: 'Library' },
      { id: 'repo', name: 'Repository' },
      { id: 'json', name: 'JSON' },
      { id: 'versions', name: 'Versions' },
      { id: 'project', name: 'Project' },
    ],
  },
  {
    label: 'Git & people',
    icons: [
      { id: 'git-branch', name: 'Git Branch' },
      { id: 'git-commit', name: 'Git Commit' },
      { id: 'git-merge', name: 'Git Merge' },
      { id: 'git-pull-request', name: 'Git Pull Request' },
      { id: 'github', name: 'GitHub' },
      { id: 'account', name: 'Account' },
      { id: 'person', name: 'Person' },
      { id: 'organization', name: 'Organization' },
      { id: 'comment', name: 'Comment' },
      { id: 'mention', name: 'Mention' },
      { id: 'broadcast', name: 'Broadcast' },
      { id: 'rss', name: 'RSS' },
    ],
  },
];

/** The groups flattened, for the validation reads that do not care about sections. */
const ICON_CHOICES: ReadonlyArray<{ id: string; name: string }> = ICON_GROUPS.flatMap((group) => group.icons);

function customIcons(): Record<string, string> {
  const stored = storage?.get<unknown>(ICONS_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, string>)
    : {};
}

/** The icon a ref was given, if it still names one this build offers. */
function storedIcon(ref: string | undefined): string | undefined {
  const id = ref ? customIcons()[ref] : undefined;
  return ICON_CHOICES.some((choice) => choice.id === id) ? id : undefined;
}

/**
 * The icon picker, on the same rows the colours are: an icon is filed under the
 * same ref a colour is — see `colorRef` — so the two annotations travel together
 * and one "Reset all icons" mirrors "Reset all colours" exactly.
 */
async function pickIcon(node: TreeNode | undefined): Promise<void> {
  const ref = node ? colorRef(node) : undefined;
  if (!ref) {
    return;
  }
  const current = storedIcon(ref);

  interface IconItem extends vscode.QuickPickItem {
    id?: string;
  }
  const items: IconItem[] = [
    {
      label: '$(discard) Default',
      description: current ? undefined : 'current',
      detail: 'The icon its category or kind gives it.',
    },
    // The sections carry the browsing case; typing filters across all of them
    // alike, separators standing aside the way quick picks always have them.
    ...ICON_GROUPS.flatMap((group): IconItem[] => [
      { label: group.label, kind: vscode.QuickPickItemKind.Separator },
      ...group.icons.map(({ id, name }) => ({
        label: `$(${id}) ${name}`,
        description: id === current ? 'current' : undefined,
        id,
      })),
    ]),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Change Icon',
    placeHolder: 'Pick an icon for this row — shown in this list only',
  });
  if (!picked) {
    return;
  }

  const icons = { ...customIcons() };
  if (picked.id) {
    icons[ref] = picked.id;
  } else {
    // `undefined` is the default, and the default is an absent entry — same
    // deal as the colours, and what keeps the menu's count honest.
    delete icons[ref];
  }
  await storage?.update(ICONS_KEY, icons);
  repaint();
}

// --- manual order ------------------------------------------------------------

/** The starred rows as a drag scope. No manifest ref can collide: they all
 * start with a folder or scheme name, never with the separator. */
const FAVORITES_SCOPE = '::favorites';

/** Scope -> the script refs in it, in the order the user dragged them into. */
function manualOrders(): Record<string, string[]> {
  const stored = storage?.get<unknown>(ORDER_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  const orders: Record<string, string[]> = {};
  for (const [scope, refs] of Object.entries(stored as Record<string, unknown>)) {
    if (Array.isArray(refs)) {
      orders[scope] = refs.filter((ref): ref is string => typeof ref === 'string');
    }
  }
  return orders;
}

/**
 * Positions each group occupies in the flat list. Rewriting only those slots
 * permutes a group internally and leaves every other group untouched, which is
 * what both passes over this list need — a drag reorders one manifest, and the
 * pin lifts a row inside one manifest.
 */
function groupSlots(scripts: ScriptEntry[]): Map<string, number[]> {
  const slots = new Map<string, number[]>();
  for (const [index, script] of scripts.entries()) {
    const scope = groupRef(script);
    const taken = slots.get(scope);
    if (taken) {
      taken.push(index);
    } else {
      slots.set(scope, [index]);
    }
  }
  return slots;
}

/**
 * The scan with the user's drags applied: inside a manifest the stored order
 * wins, and the manifests themselves stay where the scan put them.
 *
 * A script the stored order has never seen — one just added to the manifest —
 * keeps the neighbour it has there, sorting in right below the last script above
 * it that the order does know. Appending it to the bottom instead would hide a
 * new script under a list the user last touched weeks ago.
 */
function orderedScripts(scripts: ScriptEntry[]): ScriptEntry[] {
  const orders = manualOrders();
  if (Object.keys(orders).length === 0) {
    return scripts;
  }

  const result = [...scripts];
  for (const [scope, indices] of groupSlots(scripts)) {
    const order = orders[scope];
    if (!order?.length) {
      continue;
    }
    const rank = new Map(order.map((ref, index) => [ref, index]));
    let anchor = -1;
    const ranked = indices.map((slot, position) => {
      const known = rank.get(scriptRef(scripts[slot]));
      if (known !== undefined) {
        anchor = known;
      }
      return { slot, position, rank: known ?? anchor, unknown: known === undefined ? 1 : 0 };
    });
    ranked.sort((a, b) => a.rank - b.rank || a.unknown - b.unknown || a.position - b.position);
    ranked.forEach((entry, position) => {
      result[indices[position]] = scripts[entry.slot];
    });
  }
  return result;
}

/** The headings themselves as a drag scope — a drag that moves whole groups. */
const GROUPS_SCOPE = '::groups';

/**
 * The manifest groups in the order the user put them in, top to bottom. A flat
 * list rather than a map: there is only ever one order of headings, where the
 * scripts have one per heading.
 */
function groupOrder(): string[] {
  const stored = storage?.get<unknown>(GROUP_ORDER_KEY);
  return Array.isArray(stored) ? stored.filter((ref): ref is string => typeof ref === 'string') : [];
}

/**
 * The scan with the headings in the order the user put them in. Each group moves
 * as one block, so the scripts inside it keep the order the pass above gave them.
 *
 * A group the stored order has never seen — a package just added to the
 * workspace — follows the same rule a new script does: it keeps the neighbour the
 * scan gave it, sorting in right below the last group above it that the order
 * does know, rather than appearing at the bottom of a tree the user last touched
 * weeks ago.
 */
function orderedGroups(scripts: ScriptEntry[]): ScriptEntry[] {
  const order = groupOrder();
  if (order.length === 0) {
    return scripts;
  }
  const rank = new Map(order.map((ref, index) => [ref, index]));
  let anchor = -1;
  const blocks = [...groupSlots(scripts).entries()].map(([scope, indices], position) => {
    const known = rank.get(scope);
    if (known !== undefined) {
      anchor = known;
    }
    return { indices, position, rank: known ?? anchor, unknown: known === undefined ? 1 : 0 };
  });
  blocks.sort((a, b) => a.rank - b.rank || a.unknown - b.unknown || a.position - b.position);
  return blocks.flatMap((block) => block.indices.map((slot) => scripts[slot]));
}

/**
 * The refs of every group the scan found, top to bottom, in the saved order —
 * hidden ones included. A move reads and rewrites this list whole, so a heading
 * parked in HIDDEN keeps the slot it will come back to.
 */
async function groupScopes(): Promise<string[]> {
  return [...groupSlots(await savedOrder()).keys()];
}

/**
 * Writes the order of the headings. Refs the store holds that are not on this
 * list keep both their place and their existence — the same rule the favorites
 * follow, and for the same reason: a group behind a closed workspace folder is
 * absent, not deleted. Groups the store has never seen are appended, since there
 * is no slot of theirs to write over.
 */
async function saveGroupOrder(refs: string[]): Promise<void> {
  const queue = [...refs];
  const listed = new Set(refs);
  const merged = groupOrder().map((ref) => (listed.has(ref) ? (queue.shift() ?? ref) : ref));
  await storage?.update(GROUP_ORDER_KEY, [...merged, ...queue]);
}

// --- hidden groups -----------------------------------------------------------

/**
 * The headings the user has put away, and the id of the group they are put away
 * in. Hiding is not filtering: the packages are still scanned, still run, and
 * still show up in the dropdown — what the eye buys is a tree that stops naming
 * the half of a monorepo nobody on this machine works in.
 */
const HIDDEN_KEY = 'hidden';
const HIDDEN_GROUP_ID = 'group:hidden';

/**
 * The colour the pile itself wears: the theme's own word for "not now", open or
 * shut alike. The row means the same thing in both states, and a heading that
 * changes colour when you click its arrow reads as a second thing having
 * happened.
 *
 * It stops at that one row. The headings inside are drawn like any other package
 * — the pile is already saying they are put away, and greying them too made the
 * one place you go looking for a package you parked the hardest place in the
 * tree to read. A heading you painted keeps its colour there as well, which is
 * what painting one was for.
 */
const HIDDEN_COLOR = 'disabledForeground';

function hiddenRefs(): string[] {
  const stored = storage?.get<unknown>(HIDDEN_KEY);
  return Array.isArray(stored) ? stored.filter((ref): ref is string => typeof ref === 'string') : [];
}

/**
 * Puts headings away, or takes them back out. Refs are kept in the order they
 * were hidden in, so HIDDEN reads as the pile it is; where a group lands when it
 * comes back is the business of the saved order, which hiding never touched.
 */
async function setGroupsHidden(refs: string[], hidden: boolean): Promise<void> {
  const stored = hiddenRefs();
  const next = hidden
    ? [...stored, ...refs.filter((ref) => !stored.includes(ref))]
    : stored.filter((ref) => !refs.includes(ref));
  // Nothing added and nothing taken away: a group hidden twice, or brought back
  // by a drag that started outside HIDDEN. Neither is a change to write or a
  // reason to redraw the tree.
  if (next.length === stored.length) {
    clearHint();
    return;
  }
  await storage?.update(HIDDEN_KEY, next);
  clearHint();
  repaint();
}

/** The eye on a group row, and the one on a row inside HIDDEN. */
async function setGroupHidden(node: TreeNode | undefined, hidden: boolean): Promise<void> {
  const ref = node?.kind === 'group' ? node.ref : undefined;
  if (ref) {
    await setGroupsHidden([ref], hidden);
  }
}

// --- pinned running tasks ----------------------------------------------------

/**
 * Whether a running task is lifted to the top of the list it sits in.
 *
 * Off by default, because a row that stays put is a row you stop where you
 * started it: you click ▶, look away, and ◼ is still under the cursor. Turning
 * it on trades that for finding what is alive without reading the list, which is
 * the better trade once a workspace runs more at once than you can keep track of.
 */
function pinsRunning(): boolean {
  return vscode.workspace.getConfiguration('taskRunnerUltimate').get<boolean>('pinRunningTasks', false);
}

/** One list with its running rows first, each half keeping the order it had. */
function liftRunning(scripts: ScriptEntry[]): ScriptEntry[] {
  const live = scripts.filter((script) => running.has(script.key));
  return live.length === 0 ? scripts : [...live, ...scripts.filter((script) => !running.has(script.key))];
}

/**
 * The lift for a list that is already one block whole — the starred rows, in
 * both surfaces. The per-package pass below cannot serve it: the starred list
 * draws from every manifest at once, so its rows sit in slots that pass would
 * keep apart.
 */
function runningFirst(scripts: ScriptEntry[]): ScriptEntry[] {
  return pinsRunning() ? liftRunning(scripts) : scripts;
}

/**
 * The same lift, applied inside each package instead of across the flat list: a
 * running task comes first in its own group and the groups themselves do not
 * move, which is what keeps the pin from flattening the tree into one list
 * sorted by what happens to be alive.
 */
function pinRunning(scripts: ScriptEntry[]): ScriptEntry[] {
  if (!pinsRunning()) {
    return scripts;
  }
  const result = [...scripts];
  for (const indices of groupSlots(scripts).values()) {
    const rows = liftRunning(indices.map((slot) => scripts[slot]));
    indices.forEach((slot, position) => {
      result[slot] = rows[position];
    });
  }
  return result;
}

/**
 * The scan with the manifests and the user's drags in it, and nothing else. This
 * is the order a drag reads and rewrites.
 */
async function savedOrder(): Promise<ScriptEntry[]> {
  const scripts = await collectScripts();
  // Done here rather than in the scan itself: this is the one call both surfaces
  // go through, and it is the only place that holds a fresh list and the stores
  // that annotate it at the same time.
  await pruneStaleRefs(scripts);
  return orderedGroups(orderedScripts(scripts));
}

// --- pruning what the manifests no longer declare -----------------------------

/**
 * The group half of a ref — everything before the `::` that `scriptRef` joins
 * with. `undefined` when there is no `::` in it at all, which is a group's own
 * ref or one of the built-in group ids: a manifest path never contains the
 * separator, so a ref without one is not a task's.
 */
function groupOfRef(ref: string): string | undefined {
  const at = ref.indexOf('::');
  return at === -1 ? undefined : ref.slice(0, at);
}

/** The scan the prune below has already run against, so it runs once per scan. */
let prunedScan: ScriptEntry[] | undefined;

/**
 * Forgets every stored annotation whose task its manifest no longer declares.
 *
 * A `deploy` script deleted from a package.json used to leave its star, its
 * colour and its rename behind forever — invisible, but counted by the menu and
 * ready to reattach itself to a future script that happens to take the name back.
 *
 * The test is deliberately narrow: a ref goes only when the manifest it names was
 * part of this scan and did not declare it. That is the difference between "the
 * task is gone" and "the file is not here right now" — a closed workspace folder,
 * an ecosystem switched off in `sources`, a scan cut short at the manifest cap —
 * and refs of the second kind keep everything, which is the rule the favorites
 * and the saved order already followed.
 *
 * Only the stores keyed by a task are touched. Hidden packages, folded groups and
 * the order of the headings are keyed by a manifest, and a manifest losing a
 * script says nothing about whether the manifest is still there.
 */
async function pruneStaleRefs(scripts: ScriptEntry[]): Promise<void> {
  if (prunedScan === scripts) {
    return;
  }
  prunedScan = scripts;

  const scanned = new Set(scripts.map(groupRef));
  const live = new Set(scripts.map(scriptRef));
  const gone = (ref: string): boolean => {
    const group = groupOfRef(ref);
    return group !== undefined && scanned.has(group) && !live.has(ref);
  };

  for (const [key, refs] of [
    [FAVORITES_KEY, favoriteRefs()],
    [CONFIRM_KEY, confirmRefs()],
  ] as const) {
    const kept = refs.filter((ref) => !gone(ref));
    if (kept.length !== refs.length) {
      await storage?.update(key, kept);
    }
  }

  for (const [key, entries] of [
    [TITLES_KEY, customTitles()],
    [COLORS_KEY, customColors()],
    [ICONS_KEY, customIcons()],
  ] as const) {
    const kept = Object.fromEntries(Object.entries(entries).filter(([ref]) => !gone(ref)));
    if (Object.keys(kept).length !== Object.keys(entries).length) {
      await storage?.update(key, kept);
    }
  }

  const orders = manualOrders();
  const nextOrders: Record<string, string[]> = {};
  for (const [scope, refs] of Object.entries(orders)) {
    const kept = refs.filter((ref) => !gone(ref));
    // A scope with nothing left in it is a key with nothing behind it, and the
    // menu counts scopes rather than refs — an empty one would read as a list
    // still waiting to be put back.
    if (kept.length > 0) {
      nextOrders[scope] = kept;
    }
  }
  if (JSON.stringify(nextOrders) !== JSON.stringify(orders)) {
    await storage?.update(ORDER_KEY, nextOrders);
  }
}

/**
 * The scan in the order the tree shows it. The tree rebuilds from scratch on every
 * repaint, so the pin can be applied once here; the picker caches its list instead
 * and so pins in `buildItems`, at render. Both end up showing the same order.
 */
async function listScripts(): Promise<ScriptEntry[]> {
  return pinRunning(await savedOrder());
}

/**
 * The refs of a scope's rows, top to bottom, in the saved order — deliberately
 * not the one on screen. With the pin on the two differ, and a drag has to
 * rewrite the order underneath it: saving what is on screen would freeze one
 * task's run into the store and leave the list scrambled once it stops. What the
 * drag expresses is which row a row belongs next to, and that survives the pin.
 */
async function scopeRefs(scope: string): Promise<string[]> {
  const scripts = await savedOrder();
  const rows =
    scope === FAVORITES_SCOPE ? favoriteScripts(scripts) : scripts.filter((script) => groupRef(script) === scope);
  return rows.map(scriptRef);
}

async function saveOrder(scope: string, refs: string[]): Promise<void> {
  if (scope !== FAVORITES_SCOPE) {
    await storage?.update(ORDER_KEY, { ...manualOrders(), [scope]: refs });
    return;
  }
  // The starred rows are their own order, so a drag there rewrites the list itself.
  // Refs that resolve to nothing keep both their place and their existence: they
  // may belong to a closed folder, and this is a reorder, not an unstar.
  const queue = [...refs];
  const visible = new Set(refs);
  const merged = favoriteRefs().map((ref) => (visible.has(ref) ? (queue.shift() ?? ref) : ref));
  await storage?.update(FAVORITES_KEY, merged);
}

// --- menu --------------------------------------------------------------------

/** Throws the scan away and reads every manifest again. */
async function refreshScripts(): Promise<void> {
  invalidate();
  await collectScripts();
  vscode.window.setStatusBarMessage('Task & Script Explorer: reloaded', 2000);
}

interface MenuItem extends vscode.QuickPickItem {
  run?(): Promise<void>;
}

interface ResetStore {
  keys: string[];
  icon: string;
  name: string;
  count: number;
  held: string;
  confirm: string;
  detail: string;
  alwaysConfirm?: boolean;
}

/**
 * Opens the settings editor with nothing in it but this extension's own options.
 * It lives in the menu rather than in the view header: the header is for what you
 * reach for while working, and settings are what you go looking for once.
 */
function openSettings(): void {
  // Without the id the query is a plain text search, which is still better than
  // dropping the user into the whole of settings.
  void vscode.commands.executeCommand(
    'workbench.action.openSettings',
    extensionId ? `@ext:${extensionId}` : 'taskRunnerUltimate',
  );
}

/**
 * Everything the view can do that is not aimed at one row: the rescan, the
 * settings, and the stores the menu can empty. Each reset says how much is in
 * its scope before you pick it and asks once after — a mis-click here can cost
 * every rename, or every customization in the project for the final entry.
 */
async function showMenu(): Promise<void> {
  const titles = Object.keys(customTitles()).length;
  const orders = Object.values(manualOrders()).filter((refs) => refs.length > 0).length;
  const favorites = favoriteRefs().length;
  const colors = Object.keys(customColors()).length;
  const icons = Object.keys(customIcons()).length;
  const confirmations = confirmRefs().length;
  const hidden = hiddenRefs().length;
  const collapsed = foldedRefs().size;
  const reordered = orders + (groupOrder().length > 0 ? 1 : 0);
  const appliedStyles = titles + colors + icons;
  const allChanges = appliedStyles + reordered + favorites + confirmations + hidden + collapsed;

  const resetStyles: ResetStore = {
    keys: [TITLES_KEY, COLORS_KEY, ICONS_KEY],
    icon: 'discard',
    name: 'Reset all applied styles',
    count: appliedStyles,
    held: `${appliedStyles} ${appliedStyles === 1 ? 'style' : 'styles'} applied`,
    confirm: 'Reset styles',
    detail:
      'Every custom title, colour, and icon goes back to its default. Favorites, hidden packages, sort order, and folded groups stay as they are.',
    alwaysConfirm: true,
  };

  const stores: ResetStore[] = [
    {
      keys: [TITLES_KEY],
      icon: 'discard',
      name: 'Reset all titles',
      count: titles,
      held: `${titles} renamed`,
      confirm: 'Reset titles',
      detail: 'Every renamed task and package heading goes back to the name its manifest gives it.',
    },
    {
      // One entry for the two orders behind it: dragging a task and dragging the
      // heading it sits under are one thing to a user putting the tree back.
      keys: [ORDER_KEY, GROUP_ORDER_KEY],
      icon: 'list-ordered',
      name: 'Reset sort order',
      count: reordered,
      held: `${reordered} ${reordered === 1 ? 'list' : 'lists'} reordered`,
      confirm: 'Reset order',
      detail: 'Every list, and the packages themselves, go back to the order the manifests declare.',
    },
    {
      keys: [COLORS_KEY],
      icon: 'symbol-color',
      name: 'Reset all colours',
      count: colors,
      held: `${colors} painted`,
      confirm: 'Reset colours',
      detail: 'Every painted task and package heading goes back to the colour its category gives it.',
    },
    {
      keys: [ICONS_KEY],
      icon: 'symbol-misc',
      name: 'Reset all icons',
      count: icons,
      held: `${icons} changed`,
      confirm: 'Reset icons',
      detail: 'Every task and package heading goes back to the icon its category or kind gives it.',
    },
    {
      keys: [FAVORITES_KEY],
      icon: 'star-empty',
      name: 'Remove favorites',
      count: favorites,
      held: `${favorites} starred`,
      confirm: 'Remove favorites',
      detail: 'The starred rows at the top disappear. The tasks themselves stay in their packages.',
    },
    {
      keys: [CONFIRM_KEY],
      icon: 'question',
      name: 'Reset all confirmations',
      count: confirmations,
      held: `${confirmations} guarded`,
      confirm: 'Reset confirmations',
      detail: 'Every task that asks before it starts or stops goes back to starting and stopping straight away.',
    },
  ];

  const showHidden: ResetStore = {
    keys: [HIDDEN_KEY],
    icon: 'eye',
    name: 'Show hidden packages',
    count: hidden,
    held: `${hidden} hidden`,
    confirm: 'Show all',
    detail: 'The hidden group disappears and every package in it comes back to its own place in the tree.',
  };

  const resetProject: ResetStore = {
    keys: [
      TITLES_KEY,
      COLORS_KEY,
      ICONS_KEY,
      ORDER_KEY,
      GROUP_ORDER_KEY,
      FAVORITES_KEY,
      CONFIRM_KEY,
      HIDDEN_KEY,
      COLLAPSED_KEY,
    ],
    icon: 'trash',
    name: 'Reset all changes for this project',
    count: allChanges,
    held: `${allChanges} saved ${allChanges === 1 ? 'change' : 'changes'}`,
    confirm: 'Reset project',
    detail:
      'Every custom title, colour, icon, favorite, confirmation, hidden package, manual sort order, and saved folded state is cleared for this project.',
    alwaysConfirm: true,
  };

  const resetItem = (store: ResetStore): MenuItem => ({
    label: `$(${store.icon}) ${store.name}`,
    description: store.count > 0 ? store.held : 'nothing to undo',
    run: () => emptyStore(store),
  });

  const items: MenuItem[] = [
    {
      label: '$(refresh) Refresh scripts',
      description: 'read every manifest again',
      run: refreshScripts,
    },
    {
      label: '$(gear) Settings',
      description: 'every option this extension has',
      run: async () => openSettings(),
    },
    { label: 'Reset', kind: vscode.QuickPickItemKind.Separator },
    resetItem(resetStyles),
    ...stores.map(resetItem),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    resetItem(showHidden),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    resetItem(resetProject),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Task & Script Explorer',
    placeHolder: 'Pick an action',
  });
  await picked?.run?.();
}

/** One of the stores behind the menu, emptied after a confirmation. */
async function emptyStore(store: {
  keys: string[];
  name: string;
  count: number;
  confirm: string;
  detail: string;
  alwaysConfirm?: boolean;
}): Promise<void> {
  if (store.count === 0 && !store.alwaysConfirm) {
    vscode.window.showInformationMessage(`${store.name}: nothing to undo.`);
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `${store.name}?`,
    { modal: true, detail: store.detail },
    store.confirm,
  );
  if (answer !== store.confirm) {
    return;
  }
  // `undefined` deletes the key outright, so the next read falls back to the
  // empty default instead of finding an empty object left behind.
  for (const key of store.keys) {
    await storage?.update(key, undefined);
  }
  // Fold state is cached in memory because tree events can arrive faster than
  // workspace-state writes. A project-wide reset must clear both authorities.
  if (store.keys.includes(COLLAPSED_KEY)) {
    folded = undefined;
  }
  repaint();
}

// --- activity bar tree -------------------------------------------------------

type TreeNode =
  | {
      kind: 'group';
      id: string;
      /** The name the manifest itself gives the group, whatever the row shows. */
      label: string;
      detail?: string;
      folder?: string;
      /**
       * What the package calls itself — `name` in its manifest. The half of the
       * heading before the bullet, and the half a rename replaces.
       */
      place?: string;
      icon?: string;
      /** Drag scope of its rows, absent for a group nothing can be dropped in. */
      scope?: string;
      /**
       * Storage identity of the heading, present only for the groups that are a
       * manifest — the ones with a name off disk, and so the ones a rename has
       * something to restore.
       */
      ref?: string;
      /**
       * The file the heading names, for the groups that name one. Kept on the
       * node rather than read back off the first child: the two would agree
       * today, and a group whose rows are filtered or reordered is not a group
       * whose file has changed.
       */
      manifest?: vscode.Uri;
      /**
       * Whether the row is a heading the user put away — the ones under the pile,
       * and the pile itself. It is what swaps the eye on the row for the one that
       * brings it back. The grey belongs to the pile's own row and is decided by
       * its id, not by this: see `HIDDEN_COLOR`.
       */
      hidden?: boolean;
      children: TreeNode[];
    }
  | { kind: 'script'; script: ScriptEntry; inFavorites?: boolean }
  | { kind: 'foreign'; execution: vscode.TaskExecution };

const treeChanged = new vscode.EventEmitter<void>();
let treeView: vscode.TreeView<TreeNode> | undefined;
/** The same tree again, in the File Explorer. See `createTree`. */
let explorerTreeView: vscode.TreeView<TreeNode> | undefined;

/**
 * One icon for every package row: a stack, for the pile of tasks the row opens
 * into. It used to name the runner instead — npm, cargo, make — but a column of
 * different glyphs made the headings compete with the rows under them, and the
 * runner is already spelled out by the manifest each heading names.
 */
const GROUP_ICON = 'layers';

/** Private URI scheme for group rows, so decorations cannot hit real files. */
const DECORATION_SCHEME = 'taskrunnerultimate';
const TITLE_COLOR = 'taskRunnerUltimate.sourceTitleForeground';

/**
 * The spinner's colour, shared by every running row. A category colour says what
 * kind of script a row is, which is the one thing a spinning row is not being
 * asked; while it runs the icon answers "this one is busy" instead.
 *
 * A bright, saturated green — brighter than any category colour, because a
 * running row is the one thing in the tree worth finding at a glance and it has
 * to win against six of them sitting in the same column. It is close in hue to
 * the muted green `category.run` wears, which costs nothing: the two never show
 * at once on the same row, and the glyph has already changed from play to
 * spinner by then. The light default is a darker green of the same hue — a full
 * one on white is barely there.
 */
const RUNNING_COLOR = 'taskRunnerUltimate.runningForeground';

/**
 * The trees' own drag types, one per view. VS Code lower-cases mime types, so the
 * view ids are spelled out in lower case here — otherwise what we write on drag is
 * not what we look for on drop.
 *
 * A drag writes the payload under every one of them and a drop reads whichever it
 * finds: the two views draw the same rows, and a row dragged in one has to land in
 * the other. VS Code only lets a view export the mime type named after it, so the
 * list is what makes the pair interchangeable rather than two isolated trees.
 */
const DRAG_MIMES = [
  'application/vnd.code.tree.taskrunnerultimate.tree',
  'application/vnd.code.tree.taskrunnerultimate.explorer',
];

/** The list a script row belongs to: its own package, or the starred rows. */
function dragScope(node: TreeNode): string | undefined {
  if (node.kind === 'group') {
    return node.scope;
  }
  return node.kind === 'script' ? (node.inFavorites ? FAVORITES_SCOPE : groupRef(node.script)) : undefined;
}

/**
 * What a drag says about itself while it is in the air, and why a drop did
 * nothing when it lands somewhere it cannot go.
 *
 * The tree owns the drop cursor and the row highlight, and the API hands an
 * extension no say in either — `handleDrop` is only called once the drop has
 * already happened, so a forbidden target cannot be greyed out or refused under
 * the mouse. The status bar is what is left: it says where the row can go on the
 * way out, and why nothing moved on the way down.
 */
let dragHint: vscode.Disposable | undefined;

function hint(message: string): void {
  dragHint?.dispose();
  dragHint = vscode.window.setStatusBarMessage(message, 5000);
}

function clearHint(): void {
  dragHint?.dispose();
  dragHint = undefined;
}

/**
 * The dragged rows, read back from whichever of our mime types survived the trip.
 * A drag writes all of them, but a view only exports the one named after itself,
 * so which one arrives says which view the drag started in — and nothing here
 * needs to know that.
 */
async function draggedPayload(transfer: vscode.DataTransfer): Promise<string | undefined> {
  for (const mime of DRAG_MIMES) {
    const raw = await transfer.get(mime)?.asString();
    if (raw) {
      return raw;
    }
  }
  return undefined;
}

/**
 * Dragging, in two gestures. Inside one list a drag reorders it. Onto one of the
 * starred rows at the top a drag stars it too, which is an addition rather than
 * a move — the script keeps the place it has in its own package, exactly as
 * clicking ☆ leaves it.
 *
 * What is left over is a script dropped on a package that does not declare it,
 * and that one cannot be honoured at all: the groups are the manifests on disk,
 * and no gesture in a sidebar moves a script from one `package.json` to another.
 */
const dragAndDropController: vscode.TreeDragAndDropController<TreeNode> = {
  dragMimeTypes: DRAG_MIMES,
  dropMimeTypes: DRAG_MIMES,

  handleDrag(source, transfer) {
    // A heading dragged is a heading moved, which is a different edit from a task
    // dragged: it rewrites the order of the groups instead of the order inside one.
    // The two never mix in one gesture — the row the drag started on decides which
    // it is, and rows of the other kind travelling with it are left where they are.
    if (source[0]?.kind === 'group') {
      const groups = source.flatMap((node) => (node.kind === 'group' && node.ref ? [node] : []));
      const first = groups[0];
      if (!first) {
        return;
      }
      const refs = groups.flatMap((node) => (node.ref ? [node.ref] : []));
      const payload = new vscode.DataTransferItem(JSON.stringify({ scope: GROUPS_SCOPE, refs }));
      for (const mime of DRAG_MIMES) {
        transfer.set(mime, payload);
      }
      const what = refs.length > 1 ? `${refs.length} packages` : `"${groupHeading(first)}"`;
      hint(
        first.hidden
          ? `$(move) Moving ${what} — drop on any package outside hidden to bring it back`
          : `$(move) Moving ${what} — drop on another package to reorder, or on hidden to put it away`,
      );
      return;
    }

    const dragged = source.filter((node): node is TreeNode & { kind: 'script' } => node.kind === 'script');
    const scope = dragged.length > 0 ? dragScope(dragged[0]) : undefined;
    if (!scope || !dragged[0]) {
      return;
    }
    // One drag carries one scope, so a multi-select spanning two packages moves
    // only the rows that belong to the list it started in.
    const refs = dragged.filter((node) => dragScope(node) === scope).map((node) => scriptRef(node.script));
    const payload = new vscode.DataTransferItem(JSON.stringify({ scope, refs }));
    for (const mime of DRAG_MIMES) {
      transfer.set(mime, payload);
    }

    const what = refs.length > 1 ? `${refs.length} tasks` : `"${displayName(dragged[0].script)}"`;
    hint(
      scope === FAVORITES_SCOPE
        ? `$(move) Moving ${what} — drop on another starred task to reorder the top of the list`
        : `$(move) Moving ${what} — drop inside ${packageTitle(dragged[0].script)} to reorder, or on a starred task to star it`,
    );
  },

  async handleDrop(target, transfer) {
    const raw = await draggedPayload(transfer);
    // No target means the empty space below the tree, which names no position.
    if (!raw || !target) {
      clearHint();
      return;
    }

    let payload: { scope?: unknown; refs?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }
    const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
    const dragged = Array.isArray(payload.refs) ? payload.refs.filter((ref): ref is string => typeof ref === 'string') : [];
    if (!scope || dragged.length === 0) {
      clearHint();
      return;
    }

    if (scope === GROUPS_SCOPE) {
      await dropGroups(dragged, target);
      return;
    }

    const destination = dragScope(target);
    if (destination !== scope) {
      // Onto a starred row from anywhere: star it, and leave its own row where
      // it is. With no starred row on screen there is nothing to aim at, and ☆
      // on the row itself is the gesture that is always there.
      if (destination === FAVORITES_SCOPE) {
        await starDropped(dragged, target.kind === 'script' ? scriptRef(target.script) : undefined);
      } else if (scope === FAVORITES_SCOPE) {
        hint('$(circle-slash) Not a drop target — a starred task only moves among the starred rows. Click ★ to unstar it');
      } else {
        hint(`$(circle-slash) Not a drop target — a task only moves inside ${scopeName(scope)}, or onto a starred task`);
      }
      return;
    }

    const current = await scopeRefs(scope);
    const moved = dragged.filter((ref) => current.includes(ref));
    const anchor = target.kind === 'script' ? scriptRef(target.script) : undefined;
    // Dropped on itself, or on a row travelling with it: nothing to work out.
    if (moved.length === 0 || (anchor && moved.includes(anchor))) {
      clearHint();
      return;
    }

    const rest = current.filter((ref) => !moved.includes(ref));
    // The dragged rows take the target's place — dropped on the row above they
    // land in front of it, on the row below they land behind it, which is what
    // a highlighted row reads as when the tree draws no gap to aim at. Dropping
    // on the group heading has no row to take, so it means the end of the list.
    const at = anchor ? Math.min(current.indexOf(anchor), rest.length) : rest.length;
    await saveOrder(scope, [...rest.slice(0, at), ...moved, ...rest.slice(at)]);
    clearHint();
    repaint();
  },
};

/**
 * A dropped heading, in one of two gestures. On another heading it is a reorder;
 * on HIDDEN, or on anything already in it, it is a put-away — and a heading
 * dragged out of HIDDEN onto a visible one is both at once, which is the way back
 * that does not need the eye.
 *
 * A task row is a legal target as well: it names the heading it sits under, and
 * aiming at a package by one of its tasks is what a half-open tree offers.
 */
async function dropGroups(dragged: string[], target: TreeNode): Promise<void> {
  if (target.kind === 'group' && target.id === HIDDEN_GROUP_ID) {
    await setGroupsHidden(dragged, true);
    return;
  }

  const buried = new Set(hiddenRefs());
  const anchor = anchorGroup(target);
  if (!anchor) {
    hint('$(circle-slash) Not a drop target — a package moves between packages, or onto hidden');
    return;
  }
  if (buried.has(anchor)) {
    await setGroupsHidden(dragged, true);
    return;
  }

  const current = await groupScopes();
  const moved = dragged.filter((ref) => current.includes(ref));
  // Dropped on itself, or on a heading travelling with it: nothing to work out.
  if (moved.length === 0 || moved.includes(anchor)) {
    clearHint();
    return;
  }
  const rest = current.filter((ref) => !moved.includes(ref));
  // The same rule a task drop follows: the dragged rows take the target's place.
  const at = Math.min(current.indexOf(anchor), rest.length);
  await saveGroupOrder([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
  // Landing outside HIDDEN is what brings a put-away heading back, and it comes
  // back where it was dropped rather than where it was hidden from.
  await setGroupsHidden(
    moved.filter((ref) => buried.has(ref)),
    false,
  );
  clearHint();
  repaint();
}

/** The heading a drop lands on: the row itself, or the one a task row sits under. */
function anchorGroup(target: TreeNode): string | undefined {
  if (target.kind === 'group') {
    return target.ref;
  }
  return target.kind === 'script' && !target.inFavorites ? groupRef(target.script) : undefined;
}

/**
 * The heading a group row shows, for a message that has to name one. The same two
 * halves `treeItemFor` spells out, minus the case and the path: a sentence in the
 * status bar is not a row in a column of headings.
 */
function groupHeading(node: TreeNode & { kind: 'group' }): string {
  const custom = node.ref ? storedTitle(node.ref) : undefined;
  return custom ?? (node.place || node.label);
}

/** The name a scope goes by on screen, for a message that has to name one. */
function scopeName(scope: string): string {
  if (scope === FAVORITES_SCOPE) {
    return 'the starred rows';
  }
  // A renamed group is named by its heading; an untouched one has no title of
  // its own here, and its ref is the manifest path the heading also shows.
  return storedTitle(scope) ?? scope;
}

/**
 * Stars what was dropped on a starred row, at the row it was dropped on.
 * Starring is an addition, not a move: the script keeps its place in its own
 * package, which is the same thing clicking ☆ does.
 */
async function starDropped(refs: string[], anchor: string | undefined): Promise<void> {
  const stored = favoriteRefs();
  const added = refs.filter((ref) => !stored.includes(ref));
  if (added.length === 0) {
    hint('$(star-full) Already starred');
    return;
  }

  // Inserting at the anchor's index pushes the anchor down, so the new row ends
  // up in the slot it was dropped on — the same rule a reorder follows.
  const at = anchor ? stored.indexOf(anchor) : -1;
  const next = at < 0 ? [...stored, ...added] : [...stored.slice(0, at), ...added, ...stored.slice(at)];
  await storage?.update(FAVORITES_KEY, next);
  clearHint();
  repaint();
}

// --- collapsed groups --------------------------------------------------------

/**
 * The headings the user has folded shut. Everything is open by default, so the
 * store holds the exceptions: an empty store is a fully expanded tree, and a
 * group that has never been touched needs no entry to be drawn open.
 *
 * VS Code's own view-state does remember a fold, but only until the collapsible
 * state we hand it says otherwise — and every repaint hands it one. Keeping the
 * answer here is what makes a fold outlive both a repaint and a restart.
 *
 * Alone among these stores this one is held in memory as well, because alone
 * among them it is written from a stream of UI events rather than from a command:
 * the tree fires collapse and expand as fast as a user can click the arrows. This
 * set is the authority and `storage` only trails it, so a fold never reads back
 * what a previous one wrote — there is no read-modify-write for two events to
 * interleave over, and none of it depends on how promptly a `Memento` makes a
 * write visible to the next read. Nothing else writes the key, so the set cannot
 * go stale; a write that fails costs that one fold, since the next one persists
 * the set entire.
 */
let folded: Set<string> | undefined;

function foldedRefs(): Set<string> {
  if (!folded) {
    const stored = storage?.get<unknown>(COLLAPSED_KEY);
    folded = new Set(
      Array.isArray(stored) ? stored.filter((ref): ref is string => typeof ref === 'string') : [],
    );
  }
  return folded;
}

/**
 * Storage identity of a heading. The manifest ref is preferred for the same
 * reason `scriptRef` prefers it over the absolute URI: a workspace moved to
 * another path on disk keeps its folds. OTHER TASKS has no manifest, and falls
 * back to the id, which is a constant of ours.
 */
function collapseRef(node: TreeNode): string | undefined {
  return node.kind === 'group' ? (node.ref ?? node.id) : undefined;
}

/**
 * Whether a group is drawn open the first time it is seen. Everything is, bar
 * HIDDEN: it is the one group whose point is to be out of the way, and the store
 * holds its exception the other way round — a ref present there means the user
 * opened it, not that they shut it. One store, one meaning per group, and the
 * default each group wants.
 */
function startsOpen(node: TreeNode): boolean {
  return !(node.kind === 'group' && node.id === HIDDEN_GROUP_ID);
}

function isCollapsed(node: TreeNode): boolean {
  const ref = collapseRef(node);
  if (ref === undefined) {
    return false;
  }
  const stored = foldedRefs().has(ref);
  return startsOpen(node) ? stored : !stored;
}

/**
 * Records a fold. No repaint follows: the tree has already drawn the row in its
 * new state, and firing one here would fight the animation it is playing.
 *
 * Refs of groups that are no longer on screen are left in the store, as
 * favorites are — a manifest behind a closed workspace folder should find its
 * heading the way it left it.
 */
function rememberCollapse(node: TreeNode, collapsed: boolean): void {
  const ref = collapseRef(node);
  if (!ref) {
    return;
  }
  const refs = foldedRefs();
  // What the store has to hold for this row to come back in the state it is in —
  // the fold for a group that starts open, the unfold for the one that does not.
  const remember = startsOpen(node) ? collapsed : !collapsed;
  // The tree also reports the state it was handed, so an expand event arrives for
  // every group drawn open — on the first render and again after any repaint that
  // redraws one. Writing only a change keeps a repaint of a wide workspace from
  // turning into one storage write per heading, all of them saying what the store
  // already said.
  if (remember === refs.has(ref)) {
    return;
  }
  if (remember) {
    refs.add(ref);
  } else {
    refs.delete(ref);
  }
  void storage?.update(COLLAPSED_KEY, [...refs]);
}

function createTree(): vscode.Disposable[] {
  const provider: vscode.TreeDataProvider<TreeNode> = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem: treeItemFor,
    getChildren: async (node) => {
      if (!node) {
        return buildTreeRoots(await listScripts());
      }
      return node.kind === 'group' ? node.children : [];
    },
  };

  // The same tree, twice: once in its own activity bar container, and once as a
  // section at the foot of the File Explorer, for the half of the world that
  // never leaves that sidebar. Both are handed the one provider and the one
  // drag controller, so the rows, the order, the folds and the stars are the
  // same list seen from two places rather than two lists to keep in step.
  //
  // The Explorer one is contributed collapsed and behind a setting: a section
  // that opens itself is a section that has taken a file tree's space without
  // being asked.
  const view = vscode.window.createTreeView('taskRunnerUltimate.tree', {
    treeDataProvider: provider,
    dragAndDropController,
  });
  treeView = view;

  const explorerView = vscode.window.createTreeView('taskRunnerUltimate.explorer', {
    treeDataProvider: provider,
    dragAndDropController,
  });
  explorerTreeView = explorerView;
  syncTitles();

  const explorerFolds = [
    explorerView.onDidCollapseElement(({ element }) => rememberCollapse(element, true)),
    explorerView.onDidExpandElement(({ element }) => rememberCollapse(element, false)),
  ];

  // Which colour a row wants is the first segment of the uri it hands over, so a
  // repaint that changes the colour changes the uri with it. That is what makes
  // repainting work at all: decorations are cached per uri, this provider fires no
  // change event, and a colour carried by the uri is one the cache cannot serve
  // stale. It goes in the path rather than the query because the cache is keyed by
  // scheme, authority and path segments — two uris that differ only in their query
  // are the same uri to it.
  const decorations = vscode.window.registerFileDecorationProvider({
    provideFileDecoration: (uri) => {
      const [color] = uri.scheme === DECORATION_SCHEME ? uri.path.slice(1).split('/') : [];
      return color ? { color: new vscode.ThemeColor(color) } : undefined;
    },
  });

  const collapse = view.onDidCollapseElement(({ element }) => rememberCollapse(element, true));
  const expand = view.onDidExpandElement(({ element }) => rememberCollapse(element, false));

  // Only the activity bar view opens the dropdown on the way in. The Explorer
  // section becomes visible whenever someone opens the Explorer, which is not
  // the deliberate click that setting is about.
  const visibility = view.onDidChangeVisibility(({ visible }) => {
    const opensDropdown = vscode.workspace
      .getConfiguration('taskRunnerUltimate')
      .get<boolean>('openDropdownFromActivityBar', false);
    if (visible && opensDropdown) {
      void showScriptPicker();
    }
  });

  return [treeChanged, view, collapse, expand, visibility, decorations, explorerView, ...explorerFolds];
}

/**
 * One group per manifest. Scripts keep the order the manifest declares them in,
 * running or not — a row that moves when you start it is a row you have to find
 * again to stop it — unless `pinRunningTasks` says otherwise, which `listScripts`
 * has already applied by the time the rows get here. Groups are the exception:
 * one with something running floats to the top, here and in the picker alike,
 * so whatever is alive is on screen without scrolling.
 */
function buildTreeRoots(scripts: ScriptEntry[]): TreeNode[] {
  const groups: Array<{ node: TreeNode & { kind: 'group' }; hasRunning: boolean }> = [];
  const byManifest = new Map<string, (typeof groups)[number]>();
  const crowded = crowdedFolders(scripts);

  for (const script of scripts) {
    const key = script.manifest.toString();
    let group = byManifest.get(key);
    if (!group) {
      // A folder with a second manifest in it — a Cargo.toml beside a Makefile —
      // has two headings that name the same folder, so there the path after the
      // arrow carries the file name that tells them apart.
      const shared = crowded.has(manifestFolder(script));
      group = {
        node: {
          kind: 'group',
          id: `group:${key}`,
          label: manifestTitle(script),
          detail: packagePath(script),
          folder: shared ? packagePath(script) : packageFolder(script),
          place: packageHeading(script, shared),
          icon: GROUP_ICON,
          scope: groupRef(script),
          ref: groupRef(script),
          manifest: script.manifest,
          children: [],
        },
        hasRunning: false,
      };
      byManifest.set(key, group);
      groups.push(group);
    }

    group.node.children.push({ kind: 'script', script });
    if (running.has(script.key)) {
      group.hasRunning = true;
    }
  }

  // A heading the user put away leaves the list it was in and goes to the pile at
  // the bottom, taking its tasks with it. It keeps its slot in the saved order all
  // the while, so the eye that brings it back puts it back where it was.
  const buried = new Set(hiddenRefs());
  const shown = groups.filter((group) => !(group.node.ref && buried.has(group.node.ref)));
  const away = groups.filter((group) => group.node.ref && buried.has(group.node.ref));

  // Groups with something running come first — the same order the picker
  // shows and the README promises. Each half keeps the saved order, and inside
  // a group nothing moves unless `pinRunningTasks` lifts the rows too.
  const roots: TreeNode[] = [
    ...shown.filter((group) => group.hasRunning).map((group) => group.node),
    ...shown.filter((group) => !group.hasRunning).map((group) => group.node),
  ];

  // Tasks that are not backed by a manifest have no group of their own.
  const foreign = foreignExecutions();
  if (foreign.length > 0) {
    roots.unshift({
      kind: 'group',
      id: 'group:foreign',
      label: `OTHER TASKS (${foreign.length})`,
      // Nothing here comes from a manifest, so there is no runner to name. What
      // the group has in common is that all of it is already running.
      icon: 'pulse',
      children: foreign.map((execution): TreeNode => ({ kind: 'foreign', execution })),
    });
  }

  // Favorites sit above everything, including running groups: a pinned list is
  // only worth pinning if it does not move. They are rows at the root rather
  // than a group of their own — a heading over the two or three tasks you run
  // all day is a fold to open before you can click them, and the shortest list
  // in the tree is the one that least needs a lid.
  //
  // The scripts stay in their own package group as well: this is a second way
  // in, not a way out of the package it lives in. What tells the two rows apart
  // is the dimmed text, which on a starred row names the package it came from.
  //
  // Starring already writes an order, so these rows are draggable in their own
  // right: the drag rewrites the starred list instead of a manifest's order.
  const favorites = runningFirst(favoriteScripts(scripts));
  roots.unshift(...favorites.map((script): TreeNode => ({ kind: 'script', script, inFavorites: true })));

  // And the pile itself, last on the list and shut by default: a group whose
  // point is to be out of the way has not moved out of the way if it opens
  // itself. It is a drop target too — dragging a heading onto it puts it away,
  // and dragging one back out onto any other heading brings it back.
  if (away.length > 0) {
    roots.push({
      kind: 'group',
      id: HIDDEN_GROUP_ID,
      label: `hidden (${away.length})`,
      icon: 'eye-closed',
      hidden: true,
      children: away.map((group) => ({ ...group.node, hidden: true })),
    });
  }

  return roots;
}

/**
 * The resource a coloured row points at: the colour first, then something that
 * tells this row from the others. Nothing of it is on screen — the row carries
 * its own label, description and tooltip — so the path is free to be an identity
 * for the decoration cache rather than a path anyone reads.
 */
function decorationUri(color: string, name: string): vscode.Uri {
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${color}/${name}` });
}

function treeItemFor(node: TreeNode): vscode.TreeItem {
  if (node.kind === 'group') {
    // A heading is read in two registers, and the row spells each in its own way.
    //
    // The package's own name first, then after the bullet the path it lives at —
    // the name to look for and the place to find it, in that order, because the
    // name is the half being looked for and the path is the longer one.
    //
    // The project it belongs to is deliberately not repeated here. It used to
    // open every heading, which in a monorepo means printing one word down the
    // whole sidebar; a masthead that is on every row is not a masthead. It is
    // still named once, on the row of the manifest it came from — the project's
    // root package is a group like any other — and the path after the bullet
    // carries the workspace folder whenever more than one is open.
    //
    // Nothing in the row is re-cased: `acme-platform`, `@acme/webUI` and `iOS`
    // are decisions somebody made, in a manifest or on disk, and a pass that
    // walks over them makes the tree disagree with the project about what it is
    // called.
    //
    // A title typed by hand stands in for the name and is shown exactly as it
    // was typed — the case and the `-` and `_` in it are choices somebody made
    // at the prompt, and none of them are ours to redo.
    const custom = node.ref ? storedTitle(node.ref) : undefined;
    const title = custom ?? (node.place || node.label);
    // The folder is part of the label rather than a description on purpose: the
    // decoration below tints the whole label, so a joined title keeps one colour
    // across the row instead of a tinted title beside a dimmed path.
    //
    // The bullet is a separator and not a direction: the two halves are a name
    // and the path it lives at, which an arrow made look like a step from one to
    // the other. A dot the width of a space also stays out of the way of the two
    // things being read, in a column of headings where the path is the longer
    // half and the name is the half being looked for.
    //
    // The path is spelled as it is on disk, for the same reason as the folder
    // above: it is a path, and a path that has been re-cased is one you cannot
    // paste into a terminal.
    const heading = node.folder ? `${title} • ${node.folder}` : title;
    // Open unless the user has folded this one shut before: a tree you have never
    // touched shows everything it found, and one you have shows it as you left it.
    const item = new vscode.TreeItem(
      heading,
      isCollapsed(node) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
    );
    // The tooltip is where the manifest's own name survives a rename. A script
    // row keeps it in the dimmed description instead, which a heading cannot
    // use: the decoration below tints the whole label and a description with it.
    item.tooltip = node.detail ? `${node.label} — ${node.detail}` : node.label;
    // A resourceUri makes the row eligible for a file decoration, the only API
    // that can colour a tree label. The scheme is ours, so the decoration never
    // leaks onto the real file in the explorer.
    //
    // The colour lands on the whole resource label, and `.label-description`
    // has no colour of its own (only opacity), so a visible description would
    // be tinted too. The path therefore lives in the tooltip and the row shows
    // the title alone — that keeps the colour on the title and nothing else.
    //
    // A folder the user has painted wears that colour instead of the shared one,
    // on the label and on the icon alike: the point of painting one is to find it
    // in a column of headings that otherwise all look the same. OTHER TASKS takes
    // one too — it is a row on the same list, whatever it cannot be renamed to.
    const tint = nodeColor(node) ?? (node.id === HIDDEN_GROUP_ID ? HIDDEN_COLOR : TITLE_COLOR);
    item.resourceUri = decorationUri(tint, node.detail ?? node.label);
    // An icon the user picked stands in for the stock one, in the tint the row
    // already wears — the icon says which row this is, the colour keeps saying
    // what it says on every heading.
    const glyph = storedIcon(node.ref ?? node.id) ?? node.icon;
    if (glyph) {
      item.iconPath = new vscode.ThemeIcon(glyph, new vscode.ThemeColor(tint));
    }
    item.id = node.id;
    // Only a heading that names something on disk can be renamed back to it, so
    // the two kinds of group are told apart for the `when` clause that offers it.
    // A put-away heading is told apart from the rest as well: the two eyes are
    // one button in two states, and only one of them can be on a row at a time.
    // `:running` marks a heading with something alive under it, which is what
    // puts the stop-all and restart-all buttons on the row and nowhere else.
    const alive = node.children.some((child) => child.kind === 'script' && running.has(child.script.key));
    const state = node.hidden ? 'group:package:hidden' : 'group:package';
    item.contextValue = node.ref ? (alive ? `${state}:running` : state) : 'group';
    return item;
  }

  if (node.kind === 'foreign') {
    const item = new vscode.TreeItem(node.execution.task.name);
    item.description = node.execution.task.source ? `${node.execution.task.source} task` : 'task';
    item.iconPath = runningIcon();
    item.contextValue = 'foreignTask';
    item.command = { command: 'taskRunnerUltimate.toggleItem', title: 'Show Terminal', arguments: [node] };
    return item;
  }

  const isRunning = running.has(node.script.key);
  const item = new vscode.TreeItem(displayName(node.script));
  // A starred script is on screen twice, at the top of the list and in its own
  // group. Without ids of its own the tree cannot tell the two rows apart, and
  // the selection would jump between them. Built from the absolute `key` rather than
  // the storage ref, which trades uniqueness for portability.
  item.id = `${node.inFavorites ? 'fav' : 'pkg'}:${node.script.key}`;
  item.description = scriptDescription(node.script, node.inFavorites);
  // The confirmation has nothing on the row itself — a badge for a state you set
  // once and then want to forget about would cost a column of every row to say
  // nothing about most of them — so the tooltip is where it is readable without
  // opening the context menu that toggles it.
  item.tooltip = [
    commandFor(node.script),
    node.script.location,
    ...(needsConfirmation(node.script) ? ['Asks before it starts or stops.'] : []),
  ].join('\n');
  const tint = nodeColor(node);
  item.iconPath = iconFor(node.script, isRunning, tint);
  // A painted task carries the same decoration trick the headings do, which is
  // the only way a tree label takes a colour at all. The description goes with it
  // — the decoration lands on the whole resource label and `.label-description`
  // has only an opacity of its own — which is the colour on the row rather than
  // on a dot beside it, and is what painting one was for. Unpainted rows are left
  // without a resourceUri, so nothing about them changes.
  if (tint) {
    item.resourceUri = decorationUri(tint, scriptRef(node.script));
  }
  // Four independent axes in one value, matched a piece at a time by the
  // `when` clauses in contributes.menus. Each pair is spelled so that neither
  // half is a substring of the other at a `:` boundary — `:fav:` cannot be found
  // inside `:nofav:` — which is what lets one axis be matched without the three
  // around it having to be written out.
  item.contextValue = [
    'script',
    isRunning ? 'running' : 'idle',
    isFavorite(node.script) ? 'fav' : 'nofav',
    needsConfirmation(node.script) ? 'confirm' : 'noconfirm',
  ].join(':');
  item.command = {
    command: 'taskRunnerUltimate.toggleItem',
    title: isRunning ? 'Show Terminal' : 'Run',
    arguments: [node],
  };
  return item;
}

/**
 * Dimmed text after the label, in the tree and in the picker alike. The command
 * is always in it; the rest adds back whatever the label stopped saying — the
 * real script name once the row has been renamed, and the package it belongs to
 * once it is pinned at the top of the list, away from the group heading that
 * would otherwise answer that.
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
  return customGroupTitle(script) ?? script.packageName ?? packagePath(script);
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

  // The command decides only when the name said nothing, and two things keep it
  // honest. Whole tokens, not substrings: `up` must not claim `upload`, nor
  // `run` claim `prune`. And a runner's own verb is cut off first: `npm run
  // test` is a test, and the `run` in it is plumbing, not what the script does.
  const command = script.command
    .toLowerCase()
    .replace(/^(?:(?:npm|pnpm|bun|yarn)\s+run(?:-script)?|yarn|deno\s+task|composer\s+run(?:-script)?)\s+/, '');
  const commandTokens = command.split(/[^a-z0-9]+/).filter(Boolean);

  // The first token is the tool itself — `vitest run` is a test however it ends —
  // so it outranks a match anywhere else in the command.
  const head = commandTokens[0];
  const byCommandHead = head && rules.find((rule) => rule.match.includes(head));
  if (byCommandHead) {
    return byCommandHead;
  }
  return rules.find((rule) => rule.match.some((token) => commandTokens.includes(token)));
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

/**
 * A row's icon: its category's glyph, tinted.
 *
 * A colour picked from the context menu wins over the category's own and over
 * `colorIcons` with it — the setting turns off a colour we guessed at, and this
 * one the user asked for by name. It does not win over the spinner: a running
 * row is answering "this one is busy", and that answer is the same green on
 * every row for as long as it is the one worth finding.
 */
function iconFor(script: ScriptEntry, isRunning: boolean, tint?: string): vscode.ThemeIcon {
  if (isRunning) {
    return runningIcon();
  }
  const category = categoryFor(script);
  const colored = vscode.workspace.getConfiguration('taskRunnerUltimate').get<boolean>('colorIcons', true);
  const color = tint ?? (category && colored ? category.color : undefined);
  // An icon the user picked wins over the category's for the same reason the
  // colour does: the category guessed, this one was asked for by name. The
  // spinner still wins over both — a running row is answering a different
  // question.
  const glyph = storedIcon(scriptRef(script)) ?? category?.icon ?? 'play';
  return new vscode.ThemeIcon(glyph, color ? new vscode.ThemeColor(color) : undefined);
}

/**
 * The spinner every running row shows, ours and the tasks other extensions
 * started alike. It follows `colorIcons` with the category colours it replaces:
 * the setting promises every icon in the default foreground, and a row that
 * opted out of colour did not opt out of it only while idle.
 */
function runningIcon(): vscode.ThemeIcon {
  const colored = vscode.workspace.getConfiguration('taskRunnerUltimate').get<boolean>('colorIcons', true);
  return new vscode.ThemeIcon('loading~spin', colored ? new vscode.ThemeColor(RUNNING_COLOR) : undefined);
}

/**
 * The manifests that share a folder with another one, as folder paths. A Rust
 * service with a Cargo.toml, a Makefile and a justfile side by side is one
 * folder and three groups, and a heading naming the folder alone would name all
 * three the same.
 */
function crowdedFolders(scripts: ScriptEntry[]): Set<string> {
  const manifests = new Map<string, Set<string>>();
  for (const script of scripts) {
    const folder = manifestFolder(script);
    const seen = manifests.get(folder) ?? new Set<string>();
    seen.add(script.manifest.toString());
    manifests.set(folder, seen);
  }
  return new Set([...manifests].filter(([, seen]) => seen.size > 1).map(([folder]) => folder));
}

/** Absolute path of the folder a manifest sits in. */
function manifestFolder(script: ScriptEntry): string {
  return path.posix.dirname(script.manifest.path);
}

/**
 * The half of a heading between the colon and the bullet: what the package calls
 * itself, which is `name` in its `package.json`, `[package] name` in its
 * `Cargo.toml`, `module` in its `go.mod`.
 *
 * That is the name the package is known by everywhere else — in an import, in a
 * `pnpm --filter`, in the starred rows at the top of the tree — and it is not
 * always the folder it lives in: `@acme/frontend` checked out at `apps/web` was
 * a heading reading `web` until the name itself moved into the row. The folder
 * has not gone anywhere; it is the path after the bullet, where it can be pasted
 * into a terminal.
 *
 * A manifest that names nothing — a Makefile, a justfile, a `package.json`
 * without a `name` — falls back to the folder it sits in, which says more than
 * `package.json` would. Unless the folder holds another manifest as well: there
 * the file name is the only half that tells the two groups apart.
 */
function packageHeading(script: ScriptEntry, shared: boolean): string {
  if (script.packageName) {
    return script.packageName;
  }
  const folder = path.posix.basename(script.directory);
  return shared || !folder ? path.posix.basename(script.manifest.path) : folder;
}

/**
 * The name a group is known by in its manifest: the package's own name, or the
 * manifest's file name when it does not name one. What a rename restores to.
 *
 * The file name rather than the directory, because a directory can hold several
 * manifests — a Cargo.toml beside a Makefile beside a justfile is an ordinary
 * Rust repository — and three groups all titled after the same folder would say
 * nothing about which is which.
 */
function manifestTitle(script: ScriptEntry): string {
  return script.packageName ?? path.posix.basename(script.manifest.path);
}

/** Highlighted part of a group row: the user's title for it, else the manifest's. */
function packageTitle(script: ScriptEntry): string {
  return customGroupTitle(script) ?? manifestTitle(script);
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
  const name = customGroupTitle(script) ?? script.packageName;
  return name ? `${name} — ${where}` : where;
}

// --- actions shared by the tree and the picker -------------------------------

function executionOf(node: TreeNode | undefined): vscode.TaskExecution | undefined {
  if (node?.kind === 'script') {
    return running.get(node.script.key);
  }
  return node?.kind === 'foreign' ? node.execution : undefined;
}

async function runNode(node: TreeNode | undefined, reveal: boolean): Promise<void> {
  if (node?.kind === 'script' && (await confirmScript(node.script, 'run'))) {
    await startScript(node.script, reveal);
  }
}

async function stopNode(node: TreeNode | undefined): Promise<void> {
  const execution = executionOf(node);
  if (!execution) {
    return;
  }
  if (node?.kind === 'script' && !(await confirmScript(node.script, 'stop'))) {
    return;
  }
  await stopExecution(execution);
}

async function restartNode(node: TreeNode | undefined, reveal: boolean): Promise<void> {
  if (node?.kind === 'foreign') {
    // A foreign task is restarted as its owner defined it, terminal and all:
    // the presentation is part of that definition and not ours to override.
    const task = node.execution.task;
    await stopExecution(node.execution);
    await vscode.tasks.executeTask(task);
    return;
  }
  if (node?.kind !== 'script') {
    return;
  }
  // Asked once, for the restart, and then carried out through the primitives
  // rather than through `stopNode` and `runNode` — those would ask again, twice,
  // for the halves of the one thing that has already been agreed to.
  if (!(await confirmScript(node.script, 'restart'))) {
    return;
  }
  const execution = executionOf(node);
  if (execution) {
    await stopExecution(execution);
  }
  await startScript(node.script, reveal);
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

/** A group's rows that are alive right now, in the order the tree shows them. */
function runningScriptsOf(node: TreeNode | undefined): ScriptEntry[] {
  if (node?.kind !== 'group') {
    return [];
  }
  return node.children.flatMap((child) =>
    child.kind === 'script' && running.has(child.script.key) ? [child.script] : [],
  );
}

/** Stops everything running in one package group; the rest of the tree keeps going. */
async function stopGroup(node: TreeNode | undefined): Promise<void> {
  await Promise.all(
    runningScriptsOf(node).map((script) => {
      const execution = running.get(script.key);
      return execution ? stopExecution(execution) : Promise.resolve();
    }),
  );
}

/** Restarts everything running in one package group. Idle rows stay idle. */
async function restartGroup(node: TreeNode | undefined): Promise<void> {
  for (const script of runningScriptsOf(node)) {
    const execution = running.get(script.key);
    if (execution) {
      await stopExecution(execution);
    }
    await startScript(script, false);
  }
}

/**
 * How close two clicks on the same row have to sit to count as one double click.
 * The tree hands out one command invocation per click and has no double-click
 * event of its own, so the gesture is reconstructed from the timing here.
 */
const DOUBLE_CLICK_MS = 400;

/** The row the previous click landed on, for the double-click test below. */
let lastClick: { id: string; at: number } | undefined;

/**
 * What the double-click test compares. A script is its own key, which is stable
 * across repaints; a foreign row has only the task behind it to be named by.
 */
function clickId(node: TreeNode): string {
  if (node.kind === 'script') {
    return `script:${node.script.key}`;
  }
  return node.kind === 'foreign' ? `foreign:${node.execution.task.name}` : node.id;
}

/**
 * Everything a click on the row itself does, in the three states a row can be
 * clicked in.
 *
 * An idle row starts its task and brings up the output — one gesture saying
 * "run this", where the output was the point. Clicking it again goes back to
 * that output, because that is what a second look at a running dev server is
 * almost always for. Stopping it is the double click: the destructive half of
 * the old toggle now needs a gesture nobody arrives at while hunting for a log.
 */
async function activateNode(node: TreeNode | undefined, reveal: boolean): Promise<void> {
  if (!node || !executionOf(node)) {
    // A click that starts a task is never the opening half of a double click —
    // the second one would land on a task that has only just begun to run.
    lastClick = undefined;
    await runNode(node, reveal);
    return;
  }

  const id = clickId(node);
  const now = Date.now();
  const isDouble = lastClick?.id === id && now - lastClick.at <= DOUBLE_CLICK_MS;
  // A double click is consumed rather than remembered, so a third click starts
  // counting again instead of stopping whatever was started in between.
  lastClick = isDouble ? undefined : { id, at: now };
  if (isDouble) {
    await stopNode(node);
    return;
  }
  await showTerminal(node);
}

/**
 * The terminal of a running row, or the message saying why there is none.
 * Shared by the two ways of going to the output — the panel and the editor tab.
 */
function terminalOf(node: TreeNode | undefined): vscode.Terminal | undefined {
  const execution = executionOf(node);
  if (!execution) {
    return undefined;
  }

  const terminal = terminalFor(execution.task);
  if (!terminal) {
    // The task is running but its terminal has been closed — killing a task
    // terminal ends the task, so this is the window between the two, or a task
    // whose owner runs it without one.
    void vscode.window.showInformationMessage(`${execution.task.name} has no open terminal.`);
  }
  return terminal;
}

/**
 * Brings up the terminal a running task is writing to, and focuses it.
 *
 * This is the way back from a task started with ▶, which deliberately leaves
 * the panel where it was: the output is there the whole time, and this is the
 * one click that goes to it without stopping or restarting anything.
 */
async function showTerminal(node: TreeNode | undefined): Promise<void> {
  terminalOf(node)?.show();
}

/**
 * The same terminal, opened as a tab in the editor area instead of the panel.
 *
 * The panel is a strip along the bottom; a dev server's log read for more than
 * a glance wants the height of an editor, side by side with the code it talks
 * about. Moving is what the workbench offers — a terminal lives in one place at
 * a time — and `show` first makes it the active one the move command takes.
 */
async function openTerminalEditor(node: TreeNode | undefined): Promise<void> {
  const terminal = terminalOf(node);
  if (!terminal) {
    return;
  }
  terminal.show();
  await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
}

/**
 * The terminal a task runs in, matched by name because the name is the only
 * thread between the two: `TaskExecution` carries no terminal, and the task
 * system creates its terminals itself rather than through the terminal API, so
 * nothing is ever handed over to hold on to.
 *
 * What the name is depends on the workspace. VS Code names a task terminal after
 * the task's own `name` in a single-folder workspace, and after its qualified
 * label — `source: name (folder)` — in a multi-root one, where the folder is
 * what tells two identically named tasks apart. Older versions prefixed it with
 * `Task - `. Every whole form is tried before the containment test, so an exact
 * name never loses to a longer one that merely has it inside, and the forms
 * carrying the folder are tried first: in a multi-root workspace the bare name
 * is the ambiguous one.
 *
 * A miss is a real answer and not a failure to handle: a task terminal that has
 * been closed took its task with it, so the caller says so rather than opening
 * something else that happens to be there.
 */
function terminalFor(task: vscode.Task): vscode.Terminal | undefined {
  // `scope` is a folder or one of the TaskScope numbers, and only a folder has a
  // name a terminal could be carrying.
  const folder = typeof task.scope === 'object' ? task.scope : undefined;
  const names = [
    ...(folder
      ? [`${task.source}: ${task.name} (${folder.name})`, `${task.name} (${folder.name})`]
      : []),
    task.name,
    `${task.source}: ${task.name}`,
    `Task - ${task.name}`,
  ];
  for (const name of names) {
    const exact = vscode.window.terminals.find((terminal) => terminal.name === name);
    if (exact) {
      return exact;
    }
  }

  // Nothing matched whole, so fall back to containment — which is what catches
  // a naming form this list does not know yet. A terminal that names another of
  // the workspace's folders is dropped first: `scripts: dev (a)` is not the
  // terminal of folder b's `dev`, and it is the only terminal in the window
  // holding that name, so without this it would be the single hit below.
  const loose = vscode.window.terminals.filter(
    (terminal) => terminal.name.includes(task.name) && !namesAnotherFolder(terminal.name, folder),
  );
  if (loose.length <= 1) {
    return loose[0];
  }
  // Several left is a multi-root workspace where two folders each run a task of
  // this name, and the folder is the only thing that tells their terminals
  // apart. Taking the first would show one folder's log for the other folder's
  // task, so an ambiguity nothing resolves is reported as a miss instead.
  const scoped = folder
    ? loose.filter((terminal) => terminal.name.includes(`(${folder.name})`))
    : [];
  return scoped.length === 1 ? scoped[0] : undefined;
}

/**
 * Whether a terminal's name carries the mark of a workspace folder that is not
 * the one asked about — `(other)`, the suffix VS Code adds in a multi-root
 * window.
 *
 * Only the folders this window actually has count. Our own task names carry a
 * parenthesised path of their own — `dev (packages/api)` — and rejecting every
 * parenthesis would throw away the terminal that is the right answer.
 */
function namesAnotherFolder(name: string, folder: vscode.WorkspaceFolder | undefined): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    (other) => other.name !== folder?.name && name.includes(`(${other.name})`),
  );
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
  // The saved order, not the pinned one, and reassigned by `reload` when a
  // manifest changes while the picker is open. The pin is applied by `buildItems`
  // on every render instead: `render` runs again on each start and stop, and a row
  // that has just stopped can only drop back down if the list it is rebuilt from
  // still remembers where it belongs.
  let scripts = await savedOrder();

  if (scripts.length === 0 && runningCount() === 0) {
    vscode.window.showInformationMessage('No tasks found in any manifest of this workspace.');
    return;
  }

  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'Workspace tasks';
  picker.placeholder = 'Enter — run / stop · Shift+Enter or ⟳ — restart';
  picker.matchOnDescription = true;

  // A confirmation modal takes the focus, which closes the quick pick under it,
  // so a handler that started before the modal can come back to a picker that is
  // gone. The flag is what keeps it from writing to one.
  let gone = false;

  const render = () => {
    if (gone) {
      return;
    }
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
    scripts = await savedOrder();
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
      // The picker stays open over the panel, so the same rule the tree uses
      // applies here: a button acts on the row and leaves the view alone.
      await restartNode(nodeOf(item), false);
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
      // Through `runNode` rather than `startScript`, so a task that asks before
      // it starts asks here too — a modal would dismiss the picker anyway, which
      // is what the hide above has already done.
      const node = nodeOf(item);
      picker.hide();
      await runNode(node, true);
      return;
    }
    await stopNode(nodeOf(item));
    render();
  });

  picker.onDidHide(() => {
    gone = true;
    activePicker = undefined;
    void vscode.commands.executeCommand('setContext', CONTEXT_PICKER_OPEN, false);
    picker.dispose();
  });

  picker.show();
}

const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });

/**
 * The tree's shape, flattened into separators and rows: the starred tasks, then
 * the tasks that came from outside a manifest, then one block per package — the
 * packages with something running first, and inside each of them the same order
 * the tree uses. Two surfaces showing the same list in two different orders is two
 * things to learn instead of one.
 *
 * It takes the saved order and applies the pin itself, because it is re-run on
 * every start and stop while the picker stays open. Pinning before this point
 * would fix the rows where they stood when the picker was opened, and a task
 * stopped from here would keep the top slot it no longer earns.
 *
 * It departs from the tree in one place. The tree lists a starred script twice,
 * at the top and in its own package, because there the second one sits inside a
 * package heading that says what it is doing there; flattened under a separator,
 * that reads as a duplicate. So here a script has exactly one row, and a starred
 * one is lifted out of its package — its starred row names the package instead,
 * which is what the tree does too.
 */
function buildItems(saved: ScriptEntry[]): Item[] {
  const scripts = pinRunning(saved);
  const items: Item[] = [];
  const foreign = foreignExecutions();
  const multiPackage = new Set(scripts.map((script) => script.manifest.toString())).size > 1;

  const favorites = runningFirst(favoriteScripts(scripts));
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
        label: `$(loading~spin) ${execution.task.name}`,
        description: execution.task.source ? `${execution.task.source} task` : 'task',
        buttons: [restartButton(true), stopButton()],
        execution,
      });
    }
  }

  // One block per package, keeping the order the scan produced.
  const blocks = new Map<string, { label: string; items: Item[]; hasRunning: boolean }>();
  for (const script of scripts) {
    if (starred.has(script.key)) {
      continue;
    }
    const key = script.manifest.toString();
    let block = blocks.get(key);
    if (!block) {
      block = { label: packageLabel(script), items: [], hasRunning: false };
      blocks.set(key, block);
    }
    block.items.push(scriptItem(script, false));
    block.hasRunning ||= running.has(script.key);
  }

  // A separator is the only thing that closes the block above it off, so package
  // headings appear as soon as there is anything above them — including in a
  // single-package workspace, where on their own they would be pure noise.
  const headings = multiPackage || items.length > 0;
  const ordered = [...blocks.values()];

  for (const block of [...ordered.filter((b) => b.hasRunning), ...ordered.filter((b) => !b.hasRunning)]) {
    if (headings) {
      items.push(separator(block.label));
    }
    items.push(...block.items);
  }

  return items;
}

/**
 * One script row. Under Favorites it also says which package it came from, the
 * same way the tree's starred rows do — listed away from a package heading, the
 * row has to answer that itself.
 *
 * The icon is written into the label as `$(id)` rather than passed as `iconPath`,
 * which looks like the worse of the two and is not:
 *
 * - `iconPath` puts the icon in the row's own 16px slot, which carries
 *   `padding-right: 6px`. A codicon lands centred in the content box while
 *   `transform: rotate()` turns about the border box, so the spinner orbits its
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
  // The user's icon carries over from the tree: the picker and the tree are two
  // views of the same rows, and a row you marked should be findable in both.
  const icon = isRunning ? 'loading~spin' : storedIcon(scriptRef(script)) ?? categoryFor(script)?.icon ?? 'play';
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
    // Shift+Enter restarts without dismissing the picker, so nothing is revealed
    // over it — the same reason the restart button beside the row does not.
    await restartNode(nodeOf(item), false);
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

/**
 * Starts a task, showing its terminal or leaving it in the background.
 *
 * Which of the two it is says where the click landed. Clicking the row is the
 * whole row saying "run this", and what you asked for is the output — starting
 * a dev server and then having to go and find its terminal is a step the click
 * already meant. The play button beside it is the other intent: start it and
 * leave me where I am, so a build kicked off next to the one you are reading
 * does not take the panel away from it.
 *
 * The terminal exists either way and keeps its output; `Never` only means the
 * panel is not brought to it.
 */
async function startScript(script: ScriptEntry, reveal: boolean): Promise<void> {
  const execution = await vscode.tasks.executeTask(buildTask(script, reveal));
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

/**
 * Resolves when the execution ends. The event is the real signal; the poll
 * covers the cases where it never arrives, and — unlike a flat grace period —
 * it keeps waiting while the execution is still listed, so a process that takes
 * its time dying after `terminate()` is not declared gone while it still holds
 * its port, which is what would let a restart raise a second copy beside it.
 * The deadline is the way out when the task system itself never lets go.
 */
function waitForEnd(execution: vscode.TaskExecution): Promise<void> {
  const alive = () =>
    vscode.tasks.taskExecutions.some(
      (item) => item === execution || sameTask(item.task, execution.task),
    );

  return new Promise((resolve) => {
    const deadline = Date.now() + 15_000;
    const finish = () => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    };
    const poll = () => {
      if (!alive() || Date.now() >= deadline) {
        finish();
      } else {
        timer = setTimeout(poll, 500);
      }
    };
    let timer = setTimeout(poll, 500);

    const subscription = vscode.tasks.onDidEndTask((event) => {
      if (event.execution === execution || sameTask(event.execution.task, execution.task)) {
        finish();
      }
    });
  });
}

/**
 * Whether two task objects stand for the same task. Deliberately looser than
 * identity: the task system can hand out a new `TaskExecution` for a task it is
 * already running, and `waitForEnd` has to recognise the end of the one it was
 * given even when the event carries a different object.
 *
 * The scope is part of the comparison because a definition need not carry the
 * folder. Ours does — the manifest's URI is in it — but the built-in npm
 * provider's is `{ type, script, path }`, identical for a `dev` script in the
 * root of two workspace folders, and taking one folder's end event for the
 * other's would let a restart start a second copy while the first still holds
 * its port.
 */
function sameTask(a: vscode.Task, b: vscode.Task): boolean {
  return (
    a.name === b.name &&
    a.source === b.source &&
    scopeKey(a) === scopeKey(b) &&
    JSON.stringify(a.definition) === JSON.stringify(b.definition)
  );
}

/** A task's scope as one comparable string: a folder's URI, or the scope itself. */
function scopeKey(task: vscode.Task): string {
  return typeof task.scope === 'object' ? task.scope.uri.toString() : String(task.scope ?? '');
}

function buildTask(script: ScriptEntry, reveal = true): vscode.Task {
  const folder = vscode.workspace.getWorkspaceFolder(script.manifest);
  // A directory can hold a package.json, a Makefile and a justfile, each with a
  // `test`, so what disambiguates the terminal's name is the manifest and not
  // just the directory — except for a Node package, where the file name is
  // always package.json and would only be noise.
  const where = script.kind === 'npm' || script.kind === 'deno' ? script.directory : script.location;
  const argv = launchArgv(script);
  const task = new vscode.Task(
    { type: TASK_TYPE, script: script.name, manifest: script.manifest.toString() },
    folder ?? vscode.TaskScope.Workspace,
    where ? `${script.name} (${where})` : script.name,
    TASK_SOURCE,
    executionFor(argv, script.cwd.fsPath),
  );
  task.presentationOptions = {
    reveal: reveal ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Never,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    echo: true,
    focus: false,
    showReuseMessage: false,
  };
  return task;
}

/**
 * How the argv actually gets run.
 *
 * A shell, normally, because that is where a project's tools are: PATH as the
 * user's own profile leaves it — with the nvm, asdf and mise shims on it — is
 * the difference between `pnpm` being found and not. The arguments reach it
 * quoted; see `shellArgument`.
 *
 * Unless one of them cannot be quoted at all. Strong quoting wraps a value in
 * the shell's quote character, and a value carrying that same character closes
 * the quote early: `task'$(printf X)'` leaves `'…'` as `task`, a substitution
 * and an empty string, which is a name from a manifest being read as code. Such
 * a task is handed to the process runner instead, which passes the pieces to
 * the OS and never builds a line for anything to interpret.
 *
 * What that costs is the shell's PATH, and the trade is the right way round: a
 * name like that is somewhere between rare and hostile, and `npm` not being
 * found is a better outcome than running what the manifest did not name.
 */
function executionFor(argv: string[], cwd: string): vscode.ShellExecution | vscode.ProcessExecution {
  if (argv.every(quotable)) {
    return new vscode.ShellExecution(argv[0], argv.slice(1).map(shellArgument), { cwd });
  }
  return new vscode.ProcessExecution(argv[0], argv.slice(1), { cwd });
}

/**
 * Whether strong quoting is enough to make a value literal.
 *
 * A quote character of either kind is what breaks out of it, whichever shell is
 * in play — `'` for sh and PowerShell, `"` for cmd.exe — so neither is let
 * through. A control character goes with them: a newline inside a cmd.exe
 * command line ends the line, and what follows it is the next command. And on
 * Windows so does `%`, which cmd.exe expands inside double quotes, where the
 * `^` that escapes it elsewhere is itself literal.
 */
function quotable(value: string): boolean {
  if (/['"\u0000-\u001f]/.test(value)) {
    return false;
  }
  return process.platform !== 'win32' || !value.includes('%');
}

/**
 * One argument on its way to the shell.
 *
 * A plain word goes as it is, so the line echoed in the terminal reads like the
 * one you would have typed. Anything else is handed over as a quoted string and
 * VS Code quotes it for the shell that terminal actually runs: a task name is
 * the manifest's text, and `$(…)`, a backtick or a space in one is an argument
 * rather than something for the shell to read as code.
 */
function shellArgument(value: string): string | vscode.ShellQuotedString {
  return plainArgument(value) ? value : { value, quoting: vscode.ShellQuoting.Strong };
}

// --- status bar --------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem | undefined;
/** Restart-all / stop-all buttons, shown to the right of the main item only while something runs. */
let statusBarRestartItem: vscode.StatusBarItem | undefined;
let statusBarStopItem: vscode.StatusBarItem | undefined;

function syncStatusBar(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace
    .getConfiguration('taskRunnerUltimate')
    .get<boolean>('showInStatusBar', true);

  if (!enabled) {
    statusBarItem?.dispose();
    statusBarRestartItem?.dispose();
    statusBarStopItem?.dispose();
    statusBarItem = undefined;
    statusBarRestartItem = undefined;
    statusBarStopItem = undefined;
    return;
  }

  if (!statusBarItem) {
    // Higher priority sits further left, so the buttons land right after the label.
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'taskRunnerUltimate.show';
    statusBarItem.show();

    statusBarRestartItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarRestartItem.command = 'taskRunnerUltimate.restartAll';
    statusBarRestartItem.text = '$(debug-restart)';
    statusBarRestartItem.tooltip = 'Restart all running tasks';

    statusBarStopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusBarStopItem.command = 'taskRunnerUltimate.stopAll';
    statusBarStopItem.text = '$(debug-stop)';
    statusBarStopItem.tooltip = 'Stop all running tasks';

    context.subscriptions.push(statusBarItem, statusBarRestartItem, statusBarStopItem);
  }

  updateStatusBar(runningCount());
}

function updateStatusBar(count: number): void {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = count > 0 ? `$(loading~spin) Tasks: ${count}` : '$(play-circle) Tasks';
  statusBarItem.tooltip = count > 0 ? `${count} running task(s) — click to manage` : 'Show workspace tasks';

  for (const button of [statusBarRestartItem, statusBarStopItem]) {
    if (count > 0) {
      button?.show();
    } else {
      button?.hide();
    }
  }
}
