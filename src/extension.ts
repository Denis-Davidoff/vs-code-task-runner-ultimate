import * as path from 'path';
import * as vscode from 'vscode';
import { composeState } from './containers';
import { forgetIconPack, iconPack, packArt, PackIcon } from './iconTheme';
import { locateTask } from './locate';
import {
  ALL_ECOSYSTEMS,
  enabledEcosystems,
  collectScripts,
  commandFor,
  Ecosystem,
  ecosystemOf,
  emptyManifests,
  GO_GLOB,
  launchArgv,
  plainArgument,
  resetSources,
  scriptKey,
  ScriptEntry,
  SHELL_GLOB,
  SourceKind,
  SOURCE_GLOB,
  WATCH_GLOB,
} from './sources';

/** Task type used for the tasks this extension executes. Must match contributes.taskDefinitions. */
const TASK_TYPE = 'taskRunnerUltimate';
const TASK_SOURCE = 'scripts';
const CONTEXT_PICKER_OPEN = 'taskRunnerUltimate.pickerOpen';
const CONTEXT_RUNNING_COUNT = 'taskRunnerUltimate.runningCount';
/**
 * Which way the tree is grouped, for the header button that switches it.
 *
 * A `when` clause cannot read a setting, only a context key, and the button has
 * to show the mode it would put you in rather than the one you are already in —
 * so the setting is mirrored here every time it changes.
 */
const CONTEXT_HIERARCHICAL = 'taskRunnerUltimate.hierarchical';

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
    // Bringing a stack up, and taking it down. These two lead the list because
    // `up` is also a `run` word below, and here it earns a glyph of its own: the
    // pair is what a compose group is read by at a glance, so the one that
    // starts everything is filled in and the one that stops it is hollow — the
    // same solid-versus-outline pair the row's own ▶ and ■ buttons use.
    match: ['up'],
    icon: 'debug-start',
    color: 'taskRunnerUltimate.category.run',
  },
  {
    match: ['down', 'stop', 'kill', 'teardown', 'destroy'],
    icon: 'debug-stop',
    color: 'taskRunnerUltimate.category.stop',
  },
  {
    match: ['dev', 'run', 'start', 'serve', 'server', 'watch', 'preview', 'storybook', 'example'],
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
const SCAN_SETTINGS = [
  'exclude',
  'sources',
  'cargoCommands',
  'goCommands',
  'pythonRunner',
  // Both are baked into a row's `argv` by the parser rather than resolved when
  // it launches, so a change to either has to be read again off disk.
  'dockerCompose',
  'dockerComposeCommands',
  'dockerfileCommands',
  'shellScripts',
  // Both runner settings, for the same reason: `collectShellScripts` puts the
  // words in front of the path into `argv` at scan time, so a row launched after
  // one of them changed would otherwise keep running the previous command until
  // something else happened to invalidate the scan.
  'shellRunner',
  'shellRunners',
];
/** Settings that only change how the list is drawn — no rescan, just a repaint. */
const DISPLAY_SETTINGS = [
  'packageManager',
  'categories',
  'colorIcons',
  'pinRunningTasks',
  'grouping',
  'groupIcons',
];

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

/**
 * The catalogue is no longer the one on screen: a different pack, a changed one,
 * or a colour theme that draws the other half of it.
 *
 * Dropping it is half the answer. The dropdown draws its pack icons as pictures
 * — a quick pick row has no resource for the workbench to resolve one against —
 * and it reads them out of the catalogue *synchronously*, on every render. So a
 * list left open across an invalidation would lose every one of them at the next
 * keystroke. It is read again here, and the list repainted once it is back.
 *
 * The tree needs none of this: its rows name an icon rather than holding one,
 * and the workbench redraws them itself.
 */
function iconPackChanged(): void {
  forgetIconPack();
  if (activePicker) {
    void iconPack().then(() => activePicker?.refresh());
  }
}

/**
 * Whether a `.go` file sits beside a `go.mod` — the only Go files whose contents
 * decide anything, since `go run .` is about the module root and nothing below it.
 */
async function isModuleRoot(file: vscode.Uri): Promise<boolean> {
  const directory = file.with({ path: path.posix.dirname(file.path) });
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(directory, 'go.mod'));
    return true;
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  storage = context.workspaceState;
  // The settings entry in the menu filters the settings editor by this id, and
  // reading it off the context is what keeps it right if the publisher changes.
  // `ExtensionContext.extension` is stable API as of VS Code 1.62, well under the
  // 1.85 this extension asks for, so there is no id spelled out anywhere here.
  extensionId = context.extension.id;
  extensionUri = context.extensionUri;

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
    // The file behind the row rather than the task in it. The three reveal ids
    // are one action: a menu entry takes its label from the command, and the
    // file manager it opens has a different name on each platform — see the
    // `when` clauses, which offer each id on its own platform alone.
    vscode.commands.registerCommand('taskRunnerUltimate.copyRelativePath', (node?: TreeNode) =>
      copyPathOf(node, true),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.copyPath', (node?: TreeNode) =>
      copyPathOf(node, false),
    ),
    ...['mac', 'windows', 'linux'].map((platform) =>
      vscode.commands.registerCommand(
        `taskRunnerUltimate.revealFileInOS.${platform}`,
        (node?: TreeNode) => revealFile(node, false),
      ),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.revealInExplorerView', (node?: TreeNode) =>
      revealFile(node, true),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.showTerminal', (node?: TreeNode) => showTerminal(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.addToTerminal', (node?: TreeNode) =>
      addToTerminal(node),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.openTerminalEditor', (node?: TreeNode) =>
      openTerminalEditor(node),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.addFavorite', (node?: TreeNode) => setFavorite(node, true)),
    vscode.commands.registerCommand('taskRunnerUltimate.removeFavorite', (node?: TreeNode) => setFavorite(node, false)),
    // The two halves of one toggle. Two ids rather than one, for the same reason
    // the star has two: a menu entry takes its label from the command, and the
    // row has to say which way pressing it goes.
    vscode.commands.registerCommand('taskRunnerUltimate.enableConfirmation', (node?: TreeNode) =>
      setConfirmation(node, true),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.disableConfirmation', (node?: TreeNode) =>
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
    vscode.commands.registerCommand('taskRunnerUltimate.runGroup', (node?: TreeNode) => runGroup(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.stopStack', (node?: TreeNode) => stopStack(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.composeActions', (node?: TreeNode) => composeActions(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.buildImage', (node?: TreeNode) => buildImage(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.dockerfileActions', (node?: TreeNode) =>
      dockerfileActions(node),
    ),
    // ■ and ↻ on a Dockerfile row are the group's own, under names that say what
    // the row is: a Dockerfile is drawn as one line, so "all in package" is a
    // tooltip about rows the user cannot see.
    vscode.commands.registerCommand('taskRunnerUltimate.stopDockerfile', (node?: TreeNode) => stopGroup(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.restartDockerfile', (node?: TreeNode) =>
      restartGroup(node),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.restartGroup', (node?: TreeNode) => restartGroup(node)),
    // One command per colour, though the menu points at none of them any more:
    // the picker below is a list, and a list needs one command for all fifteen.
    //
    // They stay registered so that a keybinding somebody already wrote against
    // `setColor.green` does not start failing with "command not found". It will
    // not paint anything either — a command invoked from a keybinding is handed
    // no row, and `setNodeColor` has nothing to file a colour against — which is
    // why they are hidden from the command palette too. Registered so as not to
    // break, not because they work.
    ...PALETTE.map((name) =>
      vscode.commands.registerCommand(`taskRunnerUltimate.setColor.${name}`, (node?: TreeNode) =>
        setNodeColor(node, name),
      ),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.clearColor', (node?: TreeNode) =>
      setNodeColor(node, undefined),
    ),
    vscode.commands.registerCommand('taskRunnerUltimate.pickColor', (node?: TreeNode) => pickColor(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.pickIcon', (node?: TreeNode) => pickIcon(node)),
    vscode.commands.registerCommand('taskRunnerUltimate.checkContainers', () => checkContainers(true)),
    // Two commands for one button: each names the mode it puts the tree in, and
    // the `when` clauses show whichever of them is the one you do not have. A
    // single toggle would have to be titled after the state it is leaving, which
    // is the one thing a button in a header cannot show.
    vscode.commands.registerCommand('taskRunnerUltimate.groupByEcosystem', () => setGrouping('ecosystem')),
    vscode.commands.registerCommand('taskRunnerUltimate.groupFlat', () => setGrouping('flat')),
    vscode.commands.registerCommand('taskRunnerUltimate.menu', showMenu),
    vscode.commands.registerCommand('taskRunnerUltimate.stopAll', stopAllTasks),
    vscode.commands.registerCommand('taskRunnerUltimate.restartAll', restartAllTasks),
    vscode.tasks.registerTaskProvider(TASK_TYPE, {
      provideTasks: async () => (await collectScripts()).map((script) => buildTask(script)),
      resolveTask: async (task) => {
        const key = keyForTask(task);
        if (!key) {
          return undefined;
        }
        const entry = (await collectScripts()).find((item) => item.key === key);
        return entry ? buildTask(entry) : undefined;
      },
    }),
    vscode.tasks.onDidStartTask(({ execution }) => {
      clearEnded(execution);
      const key = keyForTask(execution.task);
      if (key) {
        running.set(key, execution);
      }
      onStateChanged();
    }),
    // Every ending is noted, ours and a foreign task's alike: the count is over
    // both, and a task with no row of its own still puts a number on the badge.
    vscode.tasks.onDidEndTask(({ execution }) => {
      forgetExecution(execution);
      onStateChanged();
      // A compose task of ours has just changed what is running, and this is the
      // one moment the answer is known to be stale without anyone asking. Only
      // for the file it touched, and only once it has ended.
      void recheckAfter(execution.task);
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

  // Go is the exception: its `run` row turns on the `package` clause inside the
  // file, so editing `package server` into `package main` has to reach the tree
  // — and that is a change, not a create. The glob cannot say "beside a
  // `go.mod`", so the handler asks, and a save anywhere else in a Go repository
  // costs one `stat` instead of a rescan of the workspace.
  const goWatcher = vscode.workspace.createFileSystemWatcher(GO_GLOB);
  const onGoChange = async (uri: vscode.Uri) => {
    if (await isModuleRoot(uri)) {
      invalidateSoon();
    }
  };
  goWatcher.onDidCreate(onGoChange);
  goWatcher.onDidChange(onGoChange);
  goWatcher.onDidDelete(onGoChange);

  // The shell rows are files rather than entries in a file — see `SHELL_GLOB`
  // for why the pattern is fixed rather than built from `shellScripts`. Unlike
  // `SOURCE_GLOB`, a change matters here too: the row's dimmed description is
  // the script's leading comment, so an edited header has to reach the tree.
  // The handler, not the watcher, is what `sources` switches off: a watcher is
  // built once and this one has to stay right after the setting changes.
  const shellWatcher = vscode.workspace.createFileSystemWatcher(SHELL_GLOB);
  const onShellChange = () => {
    if (enabledEcosystems().has('shell')) {
      invalidateSoon();
    }
  };
  shellWatcher.onDidCreate(onShellChange);
  shellWatcher.onDidChange(onShellChange);
  shellWatcher.onDidDelete(onShellChange);

  context.subscriptions.push(
    watcher,
    sourceWatcher,
    goWatcher,
    shellWatcher,
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
      if (event.affectsConfiguration('taskRunnerUltimate.grouping')) {
        syncGrouping();
      }
      if (event.affectsConfiguration('taskRunnerUltimate.showInStatusBar')) {
        syncStatusBar(context);
      }
      if (event.affectsConfiguration('taskRunnerUltimate.title')) {
        syncTitles();
      }
      // Not one of ours, and the only setting outside this extension worth
      // watching: the icons the picker offers are the ones the pack in this
      // setting carries, and the rows that already wear one are redrawn by the
      // workbench itself — they name an icon rather than holding one.
      if (event.affectsConfiguration('workbench.iconTheme')) {
        iconPackChanged();
      }
    }),
    // A pack installed, updated or uninstalled is the other half of the same
    // answer: the catalogue was read out of an extension folder, and that folder
    // is what just changed.
    vscode.extensions.onDidChange(() => iconPackChanged()),
    // And the colour theme decides which of a pack's two sets of icons is the
    // one being drawn — a pack with light artwork is a different catalogue under
    // a light theme, so the one held here is no longer the one on screen.
    vscode.window.onDidChangeActiveColorTheme(() => iconPackChanged()),
  );

  clearStaleBadges();
  syncStatusBar(context);
  // Before the first draw: a header with no button on it until something changes
  // reads as a header whose button is missing.
  syncGrouping();
  onStateChanged();
}

export function deactivate(): void {
  cancelInvalidate();
  running.clear();
  endedExecutions.clear();
  clearHint();
  // The same goes for every other cache of one workspace's state: the next
  // `activate` may come with another workspace's storage, whose folds and
  // container marks these must not stand in for.
  folded = undefined;
  containers.clear();
  prunedScan = undefined;
  // The module outlives a deactivate when the host keeps it loaded, so the flag
  // goes back with it: a second `activate` gets a new `context`, and the entry
  // that disposes the status bar has to be put in that one.
  statusBarRegistered = false;
}

// --- running state -----------------------------------------------------------

/**
 * Executions the task system has announced the end of while still listing them.
 *
 * `onDidEndTask` and `vscode.tasks.taskExecutions` are not in step — the same
 * lag `waitForEnd` polls around — so a count taken while the end event is being
 * handled can still see the task that has just ended. Counting it once would
 * correct itself if anything else were coming, and for a task that ends on its
 * own nothing is: that event is the last one there will be, and the count it
 * leaves behind is the badge sitting on a sidebar over a list where nothing is
 * running.
 *
 * An entry lives here until the listing itself lets go of it, so every count
 * taken in between — not only the one inside the handler — is taken without it.
 */
const endedExecutions = new Set<vscode.TaskExecution>();

/** Whether two handles can stand for the same run when identity is unavailable. */
function sameExecution(a: vscode.TaskExecution, b: vscode.TaskExecution): boolean {
  return a === b || sameTask(a.task, b.task);
}

/** Notes that an execution has ended, for as long as it is still being listed. */
function markEnded(execution: vscode.TaskExecution): void {
  endedExecutions.add(execution);
}

/**
 * Clears any note held against a task that has just started again.
 *
 * A start event carries the exact execution that is alive. Clearing by task
 * definition would also erase the note for an older sibling instance that has
 * ended but is still present in the task-system listing.
 */
function clearEnded(execution: vscode.TaskExecution): void {
  endedExecutions.delete(execution);
}

/**
 * The executions the task system lists, minus the ones it has already ended.
 *
 * End events identify executions, not task definitions. Two instances of one
 * task may be alive together, so a note for one must never hide its sibling.
 * The notes are dropped once their exact handle leaves the task listing.
 */
function liveExecutions(): vscode.TaskExecution[] {
  const listed = vscode.tasks.taskExecutions;
  for (const ended of endedExecutions) {
    if (!listed.includes(ended)) {
      endedExecutions.delete(ended);
    }
  }
  return listed.filter((item) => !endedExecutions.has(item));
}

/**
 * The handle the task system currently lists for a run, or nothing when the run
 * is over.
 *
 * Identity comes first and the match by task only behind it, because the two
 * answer different questions. A task can be running twice — `runOptions.instanceLimit`
 * is what allows it — and `sameExecution` matches either copy, so a search that
 * took the first match would hand back the run that was not asked for: stopping
 * the second one would end the first and leave the second up. The looser match
 * is still needed for the handle a caller has held since before a repaint, which
 * the task system may have replaced with a fresh object for the same run.
 */
function liveExecution(execution: vscode.TaskExecution): vscode.TaskExecution | undefined {
  const live = liveExecutions();
  return (
    live.find((item) => item === execution) ??
    live.find((item) => sameExecution(item, execution))
  );
}

/** Task executions that are running but are not backed by a package.json script. */
function foreignExecutions(): vscode.TaskExecution[] {
  return liveExecutions().filter((exec) => !keyForTask(exec.task));
}

/**
 * Drops the rows whose task the system no longer runs, and re-points the ones it
 * still does at the execution it is listing for them.
 *
 * The map is kept by events, and an event that never arrives — or that carries a
 * key the one that opened the row did not — leaves an entry behind that nothing
 * afterwards is going to remove. Everything reads that entry: the badge, the
 * status bar, the spinner on the row, the stop button offered over it. Checking
 * it against the task system costs a pass over a handful of executions and takes
 * the whole class of leftovers out at once, rather than one event's worth.
 *
 * Says whether it dropped anything, because everything that draws the row reads
 * this map: a row taken out here is a row still on screen with a spinner and a
 * stop button on it, and the caller that reconciled outside a repaint is the one
 * that has to ask for one.
 */
function pruneRunning(): boolean {
  const live = liveExecutions();
  let dropped = false;
  const liveByKey = new Map<string, vscode.TaskExecution>();
  for (const exec of live) {
    const key = keyForTask(exec.task);
    if (key !== undefined && !liveByKey.has(key)) {
      liveByKey.set(key, exec);
    }
  }
  for (const key of [...running.keys()]) {
    const alive = liveByKey.get(key);
    if (alive) {
      running.set(key, alive);
    } else {
      running.delete(key);
      dropped = true;
    }
  }
  return dropped;
}

/**
 * How many tasks are running. The map is reconciled against the task system
 * first: a count is exactly where a leftover entry shows itself, and a number
 * read off a stale map is the badge that outlives the task.
 */
function runningCount(): number {
  pruneRunning();
  // The badge counts executions, not rows. Several instances of one task share
  // one row in the tree but are still several running processes.
  return liveExecutions().length;
}

/**
 * Wipes whatever number the sidebar icon came up wearing.
 *
 * The views are new objects every activation; the badge on the icon need not be.
 * A window that closed with a task running reopens with that number still drawn,
 * and a fresh view's badge is `undefined` as far as the API is concerned — so
 * assigning `undefined` to it is not a change, nothing is sent, and the number
 * stays on an icon over a list where nothing is running. Pushing an empty badge
 * first gives the clear that follows something to be a change from.
 *
 * `onStateChanged` runs straight after and puts the real count back when there
 * is one, so the two assignments are one tick of the extension host and never a
 * badge anyone can see.
 *
 * The File Explorer view is cleared here too, and only here: earlier versions
 * put the count on it, and a badge left over from one of them would otherwise
 * sit on the File Explorer icon forever, since nothing writes to that view any
 * more.
 */
function clearStaleBadges(): void {
  for (const view of [treeView, explorerTreeView]) {
    if (view) {
      view.badge = { value: 0, tooltip: '' };
      view.badge = undefined;
    }
  }
}

function onStateChanged(): void {
  const count = runningCount();
  void vscode.commands.executeCommand('setContext', CONTEXT_RUNNING_COUNT, count);
  updateStatusBar(count);
  activePicker?.refresh();
  treeChanged.fire();
  // Only the extension's own view in the activity bar carries the badge. A
  // badge on a view is drawn on the icon of the container that view sits in,
  // and the File Explorer section sits in the File Explorer's container — so
  // badging it puts the task count on the File Explorer icon, next to a number
  // of unsaved files it has nothing to do with. The activity bar icon is the
  // extension's own, and the status bar entry carries the count for anyone who
  // reads the list from the File Explorer.
  if (treeView) {
    treeView.badge = count > 0 ? { value: count, tooltip: `${count} running task(s)` } : undefined;
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

/**
 * A tasks.json `manifest` in the spelling the scan uses for keys. Hand-written
 * (`file:///c:/…`, an unescaped space) and generated (`file:///c%3A/…`) forms
 * of one file must meet at the same key.
 */
function normalizedUri(text: string): string {
  try {
    return vscode.Uri.parse(text).toString();
  } catch {
    return text;
  }
}

/** Maps a task back to a script key, for both our tasks and built-in npm tasks. */
function keyForTask(task: vscode.Task): string | undefined {
  const definition = task.definition as { type: string; script?: string; path?: string; manifest?: string };

  if (definition.type === TASK_TYPE) {
    return definition.manifest && definition.script
      ? scriptKey(normalizedUri(definition.manifest), definition.script)
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
/** Where this extension's own files live, which is where the palette swatches are. */
let extensionUri: vscode.Uri | undefined;

/**
 * Storage identity of a workspace folder. Its name, which is what the workspace
 * itself calls it — until two folders answer to the same one.
 *
 * A multi-root workspace is free to hold `/work/frontend/app` beside
 * `/work/backend/app`, and both are named `app`. Left at that, every ref under
 * them collides: a rename, a colour or a star put on one folder's `dev` lands on
 * the other's as well, and the tree draws the second folder's script under the
 * first folder's favorites. So a name shared by more than one folder is grown
 * leftwards along its own path until the colliding folders no longer match —
 * `frontend/app` and `backend/app`.
 *
 * Only the folders in a collision pay for it, and only while it lasts: adding a
 * second `app` to a workspace does move the first one's stored annotations out
 * of reach, which is the price of not silently merging two folders' settings.
 * Everything else keeps the plain name it has always been stored under.
 */
function folderRef(folder: vscode.WorkspaceFolder): string {
  const others = (vscode.workspace.workspaceFolders ?? []).filter(
    (other) => other !== folder && other.name === folder.name,
  );
  if (others.length === 0) {
    return folder.name;
  }
  const segments = folder.uri.fsPath.split(path.sep).filter(Boolean);
  const tails = others.map((other) => other.uri.fsPath.split(path.sep).filter(Boolean));
  for (let depth = 2; depth <= segments.length; depth++) {
    const suffix = segments.slice(-depth);
    const shared = tails.some(
      (tail) => tail.slice(-depth).join('/') === suffix.join('/'),
    );
    if (!shared) {
      return suffix.join('/');
    }
  }
  // Two folders with the same absolute path are the same folder; nothing else
  // reaches here, and the whole path is as unique as anything gets.
  return segments.join('/');
}

/**
 * Storage identity of a manifest — its workspace folder plus where in it the file
 * sits, e.g. `my-app/packages/api/package.json`. Read off the URI rather than
 * taken from `ScriptEntry.location` so that a manifest with no tasks left in it
 * can be named too; the two are the same string by construction.
 */
function manifestRef(manifest: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(manifest);
  if (!folder) {
    return manifest.toString();
  }
  const relative = path.relative(folder.uri.fsPath, manifest.fsPath).split(path.sep).join('/');
  return `${folderRef(folder)}/${relative || path.posix.basename(manifest.path)}`;
}

/**
 * Storage identity of the group a script belongs to — its manifest, named the
 * way the workspace sees it, e.g. `my-app/packages/api/package.json`. Doubles as
 * the scope a drag is allowed to move a script inside of.
 */
function groupRef(script: ScriptEntry): string {
  return manifestRef(script.manifest);
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

/**
 * The manifest kinds the tree draws as a single row rather than as a folder of
 * rows — see `isFileItem`, which reads this for the node side of the same
 * question. Kept as a set of kinds because the rules that turn on it are about
 * the *task*, which knows its kind and not the node it is drawn under.
 */
function isItemKind(kind: SourceKind): boolean {
  return kind === 'docker-compose' || kind === 'dockerfile';
}

/**
 * Never an action of a file the tree draws as one row, whatever is stored
 * against it.
 *
 * A compose file and a Dockerfile are one leaf each — ▶, the buttons beside it
 * and a menu of extra commands, with no rows underneath — so there is nowhere to
 * put the toggle and nowhere to turn it back off. A dialog naming a switch the
 * user cannot reach is worse than no dialog, and ▶ on a stack or an image is
 * already the deliberate gesture the flag exists to make you perform: pressing it
 * is a decision about the whole file, not about one row among forty.
 *
 * Starring does not buy the toggle back. A starred row is drawn in the favourites
 * with a full menu, but starring needs a row to star and the dropdown offers no
 * star — so a flag set on one of these would be a setting with no way off but the
 * global reset, which is the whole of what this rule prevents.
 *
 * Flags left on such a row by an older version are dropped rather than honoured
 * in silence — see `pruneStaleRefs`.
 */
function needsConfirmation(script: ScriptEntry): boolean {
  return !isItemKind(script.kind) && confirmRefs().includes(scriptRef(script));
}

/** The two halves of the toggle in the context menu, one command each. */
async function setConfirmation(node: TreeNode | undefined, on: boolean): Promise<void> {
  // These rows carry no confirmation axis in their context value, so neither
  // half of the toggle is ever on their menu. Refused here as well, for the
  // command invoked any other way.
  if (node?.kind !== 'script' || isItemKind(node.script.kind)) {
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
    { modal: true, detail: `${detail} Turn that off with "Disable Confirmation" in its context menu.` },
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
  // A heading that stands for a folder rather than a file — the shell groups —
  // has nothing to open as a document, so the folder is revealed instead.
  // Leaving it without a manifest would make the menu entry a silent no-op.
  if (node?.kind === 'group' && node.directory) {
    await vscode.commands.executeCommand('revealInExplorer', node.directory);
    return;
  }

  // OTHER TASKS and HIDDEN are groups of ours rather than files, and carry no
  // manifest — the `when` clauses keep them out of the menu, and this keeps them
  // out of the command.
  const source: { file: vscode.Uri; where: string; task?: ScriptEntry } | undefined =
    node?.kind === 'script'
      ? {
          // A shell row's manifest is the directory it is grouped under, so the
          // file it opens is the script itself.
          file: node.script.file ?? node.script.manifest,
          where: node.script.file
            ? vscode.workspace.asRelativePath(node.script.file)
            : node.script.location,
          task: node.script,
        }
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

/**
 * The file or folder a row stands for, which is what the four path actions act
 * on. A heading is its manifest, or — for the shell groups, which are a folder
 * of loose scripts and no one file — the directory it stands for, the same two
 * `openManifest` chooses between. A shell row is the script file it runs.
 *
 * A manifest task has no path of its own: it is a line in a file its siblings
 * share, and `script.manifest` would answer for the group rather than the row.
 * The `when` clauses keep those rows out of the menu — see `PATH_ROW` in
 * `tools/generate-contributions.js` — and this answers `undefined` for them so a
 * keybinding aimed at one is a no-op rather than four rows' worth of the same
 * package.json on the clipboard.
 */
function fileBehind(node: TreeNode | undefined): vscode.Uri | undefined {
  if (node?.kind === 'group') {
    return node.manifest ?? node.directory;
  }
  return node?.kind === 'script' ? node.script.file : undefined;
}

/**
 * Puts the row's path on the clipboard, relative to the workspace or whole.
 * `asRelativePath` names the workspace folder as well when there is more than
 * one open, which is what makes the relative half of the pair unambiguous in the
 * multi-root case that produces most of these rows.
 */
async function copyPathOf(node: TreeNode | undefined, relative: boolean): Promise<void> {
  const file = fileBehind(node);
  if (!file) {
    return;
  }
  await vscode.env.clipboard.writeText(relative ? relativePathOf(file) : file.fsPath);
}

/**
 * The row's path with the workspace cut off the front — and its own name when
 * there is nothing to cut.
 *
 * `asRelativePath` hands the input straight back when it cannot place it, and a
 * folder that *is* a workspace root is exactly that case: it resolves the parent
 * of the URI and finds no folder above it. That is reachable by default rather
 * than at the edges — `shellScripts` picks up a script sitting at the root of the
 * project, and the heading for those is the root itself — and copying the
 * absolute path there would silently make this entry the one below it.
 *
 * The same fallback `manifestRef` takes above and the shell scan takes for a
 * group's `location`, for the same reason both do: the name of the folder is what
 * that row is called everywhere else, so it is what a paste of it should say.
 */
function relativePathOf(file: vscode.Uri): string {
  const cut = vscode.workspace.asRelativePath(file);
  return cut === file.fsPath || cut === file.path ? path.posix.basename(file.path) : cut;
}

/**
 * Shows the row's file where the user asked for it: `revealFileInOS` is Finder,
 * File Explorer or the desktop's file manager, `revealInExplorer` the workbench's
 * own side bar. Both are the workbench's commands rather than ours, so both
 * behave here exactly as they do from the Explorer's context menu — a directory
 * included, which is what a shell group hands them.
 */
async function revealFile(node: TreeNode | undefined, inWorkbench: boolean): Promise<void> {
  const file = fileBehind(node);
  if (!file) {
    return;
  }
  await vscode.commands.executeCommand(
    inWorkbench ? 'revealInExplorer' : 'revealFileInOS',
    file,
  );
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
 * The colours a row can be painted, in the order the picker lists them: around
 * the wheel from red, with the two neutrals last, which is where a row being
 * turned down rather than picked out belongs.
 *
 * Kept in step with the PALETTE in `tools/generate-contributions.js`, which is
 * where the shades themselves are declared and where the swatch files and the
 * `contributes.colors` entries are made from them.
 *
 * The store keeps these names rather than the theme colour ids behind them. A
 * name is what the user picked, and the id it maps to stays ours to move; a
 * store full of ids is one that goes blank the day one of them is renamed. It is
 * also what lets a name this build no longer offers be ignored rather than
 * handed to `ThemeColor` as a colour nothing declares.
 */
const PALETTE = [
  'red',
  'orange',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'purple',
  'magenta',
  'pink',
  'brown',
  'slate',
  'gray',
] as const;

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
 * The swatch a colour is drawn with in the picker, as a pair the workbench picks
 * between. A file rather than a `ThemeIcon` carrying the palette colour itself,
 * because VS Code turns a `ThemeIcon` into a bare codicon on the way into a quick
 * pick and drops the colour doing it — only URI icons are drawn in colour there.
 *
 * The cost of that is one thing worth knowing: a swatch is the shade the palette
 * ships, so a colour overridden in `workbench.colorCustomizations` is painted on
 * the row as the override and drawn here as the original.
 */
function swatch(name: PaletteName): { light: vscode.Uri; dark: vscode.Uri } | undefined {
  return extensionUri
    ? {
        light: vscode.Uri.joinPath(extensionUri, 'media', `swatch-${name}-light.svg`),
        dark: vscode.Uri.joinPath(extensionUri, 'media', `swatch-${name}-dark.svg`),
      }
    : undefined;
}

/**
 * The colour picker, on the same rows the icons are and now in the same shape.
 *
 * It was a submenu of one command per colour until the palette outgrew it: a
 * platform menu draws no icons, so every swatch had to be spelled as a character
 * in the label, and Unicode has no coloured circle for teal, pink, grey or any of
 * the five this list gained. A quick pick draws a real one, which is what lets
 * fifteen colours be told apart by eye rather than read.
 */
async function pickColor(node: TreeNode | undefined): Promise<void> {
  const ref = node ? colorRef(node) : undefined;
  if (!ref) {
    return;
  }
  const current = storedColor(ref);

  interface ColourItem extends vscode.QuickPickItem {
    name?: PaletteName;
  }
  const items: ColourItem[] = [
    {
      label: '$(discard) Default',
      description: current ? undefined : 'current',
      detail: 'The colour its category or kind gives it.',
    },
    ...PALETTE.map((name): ColourItem => ({
      label: name.charAt(0).toUpperCase() + name.slice(1),
      description: name === current ? 'current' : undefined,
      iconPath: swatch(name),
      name,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Change Colour',
    placeHolder: 'Pick a colour for this row — shown in this list only',
  });
  if (picked) {
    // `undefined` on the Default row, which is what takes the colour back off.
    await setNodeColor(node, picked.name);
  }
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
      { id: 'debug-start', name: 'Start' },
      { id: 'stop-circle', name: 'Stop' },
      { id: 'debug-stop', name: 'Stop (Square)' },
      { id: 'record', name: 'Record' },
      { id: 'check', name: 'Check' },
      { id: 'checklist', name: 'Checklist' },
      { id: 'tasklist', name: 'Task List' },
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
      { id: 'snake', name: 'Snake' },
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
      { id: 'terminal-bash', name: 'Terminal Bash' },
      { id: 'terminal-powershell', name: 'Terminal PowerShell' },
      { id: 'terminal-cmd', name: 'Terminal Command Prompt' },
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
 * The other half of the same store: an icon taken from the file icon theme the
 * workbench is wearing, kept as the *name* that reaches it rather than as
 * anything belonging to the pack it was picked from — see `iconTheme.ts` for why.
 *
 * One store holds both kinds because a row has one icon, whichever list it came
 * from, and one "Reset all icons" should answer for all of them. They are told
 * apart by the prefix: no codicon id has a colon in it, so an entry either names
 * a glyph in the font or a file the workbench knows how to draw.
 */
interface Specimen {
  /** Which of the two the workbench has to be shown to draw the icon. */
  readonly kind: 'file' | 'folder';
  /** The name to show it. */
  readonly name: string;
}

function specimenValue(icon: PackIcon): string {
  return `${icon.kind}:${icon.specimen}`;
}

function storedSpecimen(ref: string | undefined): Specimen | undefined {
  const value = ref ? customIcons()[ref] : undefined;
  if (typeof value !== 'string') {
    return undefined;
  }
  // Nothing is checked against the pack that was installed when it was picked.
  // That is the point of keeping a name: a pack swapped out since answers for
  // `Dockerfile` too, and a pack that has nothing to say about it draws its own
  // default file icon, which is the same answer the Explorer gives that name.
  const [kind, ...rest] = value.split(':');
  const name = rest.join(':');
  return name && (kind === 'file' || kind === 'folder') ? { kind, name } : undefined;
}

/**
 * What to hand `TreeItem.iconPath` for a specimen. The icon itself is never
 * loaded by us: this says "draw this the way you would draw that file", and the
 * name it goes with rides on the row's `resourceUri`.
 */
function specimenIcon(specimen: Specimen): vscode.ThemeIcon {
  return specimen.kind === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
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
  const currentSpecimen = storedSpecimen(ref);
  // Read before the list is shown rather than while it is: a pack is a file on
  // disk, and a quick pick that opens empty and fills in a moment is one you
  // have already started typing into. It is read once and kept — see `iconPack`.
  const pack = await iconPack();

  interface IconItem extends vscode.QuickPickItem {
    id?: string;
    specimen?: string;
  }
  const items: IconItem[] = [
    {
      label: '$(discard) Default',
      description: current || currentSpecimen ? undefined : 'current',
      detail: 'The icon its category or kind gives it.',
    },
    // The icon font VS Code ships with comes first, in its five sections. It is
    // the set every machine has, the same on all of them, and the one somebody
    // opening this list for the first time is looking at — a hundred glyphs
    // ahead of eight hundred pictures is also the shorter half to scroll past.
    //
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
    // Then whatever pack is installed, under its own name — the set that is not
    // ours and not every machine's, which is what puts it after the one that is.
    //
    // The icons are drawn from the pack's own files. Only for the preview: what
    // a row is given is the name under each entry, which is what the workbench
    // matches on. A pack with no files to draw from — Seti draws from a font —
    // still lists, without the pictures.
    ...(pack
      ? [
          { label: pack.label, kind: vscode.QuickPickItemKind.Separator } as IconItem,
          ...pack.icons.map((icon): IconItem => {
            const specimen = specimenValue(icon);
            const held = currentSpecimen && specimen === `${currentSpecimen.kind}:${currentSpecimen.name}`;
            return {
              label: icon.name,
              description: held ? `${icon.hint} · current` : icon.hint,
              iconPath: icon.art ? vscode.Uri.joinPath(pack.base, icon.art) : undefined,
              specimen,
            };
          }),
        ]
      : []),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Change Icon',
    placeHolder: 'Pick an icon for this row — shown in this list only',
    // The name beside a pack icon is the half worth typing: `*.rs` and
    // `Dockerfile` are how you look for one, and the pretty name above it is
    // often not what the file is called.
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }

  const icons = { ...customIcons() };
  if (picked.specimen) {
    icons[ref] = picked.specimen;
  } else if (picked.id) {
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

/**
 * The id of the heading the starred rows sit under in `ecosystem` mode. A
 * constant of ours rather than a manifest ref, which is what `collapseRef` and
 * the colour and icon stores key the row on — see `buildTreeRoots` for why the
 * heading exists in that mode and not in `flat`.
 */
const FAVORITES_GROUP_ID = 'group:favorites';

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
 * Whether the manifest groups sit under one parent row per ecosystem, rather
 * than all at the root.
 *
 * `flat` is the default: it is what the tree has always drawn, and an upgrade
 * that restructures a sidebar nobody asked to have restructured is an upgrade
 * that reads as a bug.
 */
function hierarchical(): boolean {
  return (
    vscode.workspace.getConfiguration('taskRunnerUltimate').get<string>('grouping', 'flat') ===
    'ecosystem'
  );
}

/**
 * The scan with each ecosystem's groups gathered into one run, in the order the
 * ecosystems first appear. A near-twin of `orderedGroups` above, and applied
 * right after it, so a drag still decides the order inside a run.
 *
 * This is a pass over the flat list and not something the tree does while it
 * builds its rows, which is the load-bearing part. `groupScopes()` — what every
 * drop splices positions into — reads this same list, so bucketing here is what
 * keeps the order a drag computes against and the order on screen the same
 * thing. Were the tree to bucket on its own, a stored order of `node, rust,
 * node` would draw as two blocks while the drop arithmetic still saw three, and
 * the dropdown would list a third order again.
 *
 * A run's rank is where its first member sits, so no second store is needed.
 * One would have to be reset, pruned and documented on its own, and could
 * contradict `groupOrder` with nothing to reconcile the two.
 */
function groupedByEcosystem(scripts: ScriptEntry[]): ScriptEntry[] {
  if (!hierarchical()) {
    return scripts;
  }
  const rank = new Map<Ecosystem, number>();
  const blocks = [...groupSlots(scripts).values()].map((indices, position) => {
    // Every row in a block comes from one manifest, so one row settles its kind.
    const ecosystem = ecosystemOf(scripts[indices[0]].kind);
    if (!rank.has(ecosystem)) {
      rank.set(ecosystem, rank.size);
    }
    return { indices, position, rank: rank.get(ecosystem) ?? 0 };
  });
  blocks.sort((a, b) => a.rank - b.rank || a.position - b.position);
  return blocks.flatMap((block) => block.indices.map((slot) => scripts[slot]));
}

/**
 * The scan with each compose file and script folder moved to sit directly after
 * the project it belongs to, in `flat` mode.
 *
 * The twin of `groupedByEcosystem`, and here for the same load-bearing reason.
 * The tree re-parents these rows by their paths, which changes what is drawn but
 * not the flat list underneath — so the dropdown listed them in scan order, the
 * drag arithmetic computed against a third order, and the two surfaces the
 * README calls "the tree flattened" disagreed out of the box. Moving the blocks
 * here makes every reader of `savedOrder` agree, and `attachToHosts` is then
 * only folding a list that is already in the right order.
 *
 * Returns the input untouched in `ecosystem` mode, where nothing is attached.
 */
function orderedByHost(scripts: ScriptEntry[]): ScriptEntry[] {
  if (hierarchical()) {
    return scripts;
  }
  const blocks = [...groupSlots(scripts).entries()].map(([ref, indices]) => ({
    ref,
    indices,
    // Every row in a block comes from one manifest, so one row settles its kind.
    script: scripts[indices[0]],
  }));

  // A put-away project hosts exactly what it hosted before, since that is where
  // the tree still draws these blocks — inside it, in the pile. Filing them
  // anywhere else here would have the dropdown list them somewhere the tree
  // never put them, which is the one thing this pass exists to prevent.
  const hosts = attachedHosts(
    blocks.map((block) => ({
      ref: block.ref,
      at: manifestFolder(block.script),
      kind: block.script.kind,
    })),
  );

  const attached = new Map<string, Array<(typeof blocks)[number]>>();
  const roots: Array<(typeof blocks)[number]> = [];
  for (const block of blocks) {
    const host = hosts.get(block.ref);
    if (host === undefined) {
      roots.push(block);
      continue;
    }
    attached.set(host, [...(attached.get(host) ?? []), block]);
  }
  if (attached.size === 0) {
    return scripts;
  }

  return roots
    .flatMap((block) => [block, ...(attached.get(block.ref) ?? [])])
    .flatMap((block) => block.indices.map((slot) => scripts[slot]));
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
  // The two grouping passes are exclusive by mode, and each is the last word on
  // where a block sits: one gathers ecosystems, the other tucks a project's
  // surroundings in behind it.
  return orderedByHost(groupedByEcosystem(orderedGroups(orderedScripts(scripts))));
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
 * A manifest counts as scanned when it produced a row and when it produced none:
 * the last script of a package.json is exactly the one whose star would otherwise
 * outlive it, since with it goes the only entry that named the file.
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

  // The shell groups are left out on purpose, which is the same narrowness the
  // rest of this rule already has. A manifest is a file that was read, so what
  // it does not declare is gone; a shell group is a directory whose contents
  // reached us through `shellScripts` and a 200-file cap, so a script missing
  // from the list may only have been narrowed out or truncated away. Pruning on
  // that evidence deletes stars and colours for files that are still on disk.
  // The cost is the other way round and is the one this rule always pays: a
  // script deleted for real keeps its marks, as a closed workspace folder does.
  const scanned = new Set([
    ...scripts.filter((script) => !script.file).map(groupRef),
    ...emptyManifests().map(manifestRef),
  ]);
  const live = new Set(scripts.map(scriptRef));
  const gone = (ref: string): boolean => {
    const group = groupOfRef(ref);
    return group !== undefined && scanned.has(group) && !live.has(ref);
  };

  // A compose row and a Dockerfile row do not ask any more — see
  // `needsConfirmation` — so a flag an older version left on one is a setting
  // with nothing behind it: it changes nothing, has no toggle to clear it, and
  // still counts in the ⋮ menu's tally of guarded rows. Dropped here, where the
  // scan says which refs those are. The Dockerfile half matters on upgrade: its
  // rows were ordinary rows with the toggle on them until they became one leaf.
  // Stars are not dropped: such a row can still be starred, and still shows in
  // the favourites at the top.
  const unguarded = new Set(scripts.filter((script) => isItemKind(script.kind)).map(scriptRef));

  for (const [key, refs, dropped] of [
    [FAVORITES_KEY, favoriteRefs(), undefined],
    [CONFIRM_KEY, confirmRefs(), unguarded],
  ] as [string, string[], Set<string> | undefined][]) {
    const kept = refs.filter((ref) => !gone(ref) && !dropped?.has(ref));
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
  // Refresh re-reads the world, and the task system is part of it: the count on
  // the badge and in the status bar is checked against what is actually running,
  // which is the way back for anyone looking at a number they cannot explain.
  onStateChanged();
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
 * Puts `grouping` into one of its two modes.
 *
 * Written globally by default: a click in a menu should not put a
 * `.vscode/settings.json` into the user's `git status`. But `grouping` is an
 * ordinary window-scoped setting, so a repository may already pin it — and a
 * global write is then shadowed by that value, which left the button switching
 * nothing, saying nothing, every time, forever. So the write goes where the
 * value that wins already lives, and only falls back to the global one when
 * nothing else holds it.
 *
 * A folder-scoped value is the case this cannot aim at: targeting one needs a
 * resource, and this setting is about the view rather than about any one folder.
 * That is what the check afterwards is for — it costs one read and turns the
 * silent version of this failure into a sentence naming the setting.
 *
 * No repaint follows the write, because `update` resolves after the
 * configuration event has fired and `grouping` is on `DISPLAY_SETTINGS` — the
 * redraw is already on its way, and `syncGrouping` rides on the same event so
 * the header button turns over with the tree rather than after it.
 */
async function setGrouping(mode: 'flat' | 'ecosystem'): Promise<void> {
  const settings = vscode.workspace.getConfiguration('taskRunnerUltimate');
  const held = settings.inspect<string>('grouping');
  const target =
    held?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await settings.update('grouping', mode, target);
  if (hierarchical() === (mode === 'ecosystem')) {
    return;
  }
  // Something with the last word is still holding the old value — a folder
  // setting, or a policy. Saying so beats a button that looks broken.
  void vscode.window.showWarningMessage(
    `Grouping is pinned to "${hierarchical() ? 'ecosystem' : 'flat'}" by a setting this view cannot write. Change taskRunnerUltimate.grouping where it is set.`,
  );
}

/** The ☰ menu's half of the same switch, which names one thing and toggles it. */
async function toggleGrouping(): Promise<void> {
  await setGrouping(hierarchical() ? 'flat' : 'ecosystem');
}

/**
 * Mirrors `grouping` into the context key the header button is drawn from.
 *
 * Called once on the way in and again on every configuration change, which
 * covers the button being pressed, the setting being edited by hand, and a
 * workspace being opened with a different mode saved in it.
 */
function syncGrouping(): void {
  void vscode.commands.executeCommand('setContext', CONTEXT_HIERARCHICAL, hierarchical());
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
    {
      label: '$(archive) Check containers',
      description: 'ask Docker what is up',
      detail: 'Marks the compose rows whose containers are running, including a stack started outside this window.',
      run: () => checkContainers(true),
    },
    {
      label: '$(list-tree) Group by ecosystem',
      // The same idiom the resets below use for a state: what it is now, on the
      // right, where the eye is already going for the count.
      description: hierarchical() ? 'on' : 'off',
      detail: 'One row per ecosystem — Node, Rust, Docker — with the packages inside it.',
      run: toggleGrouping,
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
       * The directory a heading stands for, when it stands for one rather than
       * for a file — the shell groups, which are a folder of scripts and no one
       * manifest. It is what Open Manifest reveals instead of trying to open a
       * directory as a document.
       */
      directory?: vscode.Uri;
      /**
       * Which ecosystem the heading belongs to. On a manifest group it decides
       * the glyph; on a parent row it is what the row *is*, and is what a drag
       * reads to work out which block it is moving.
       */
      ecosystem?: Ecosystem;
      /** What kind of manifest the heading is, for the two rules that turn on it. */
      source?: SourceKind;
      /**
       * The folder the heading occupies — the directory a manifest sits in, and
       * for a shell group the directory it *is*. What `attachToHosts` matches
       * projects and their surroundings on.
       */
      at?: string;
      /**
       * Whether the row is a heading the user put away — the ones under the pile,
       * and the pile itself. It is what swaps the eye on the row for the one that
       * brings it back. The grey belongs to the pile's own row and is decided by
       * its id, not by this: see `HIDDEN_COLOR`.
       */
      hidden?: boolean;
      /**
       * Whether the row is in the pile only because the project it is drawn
       * inside of is. A compose file and a script folder travel with their
       * project — see `buildTreeRoots` — but neither was put away in its own
       * right, so neither eye belongs on them: there is nothing to bring back on
       * its own, and nothing left to put away.
       */
      carried?: boolean;
      children: TreeNode[];
    }
  | {
      kind: 'script';
      script: ScriptEntry;
      inFavorites?: boolean;
      /**
       * The folder a row came from, for the rows a `shell` heading has gathered
       * out of several — see `attachToHosts`. One heading over `scripts/` and
       * `bin/` would otherwise draw two `build.sh` rows that read identically.
       */
      origin?: string;
    }
  | { kind: 'foreign'; execution: vscode.TaskExecution };

const treeChanged = new vscode.EventEmitter<void>();
let treeView: vscode.TreeView<TreeNode> | undefined;
/** The same tree again, in the File Explorer. See `createTree`. */
let explorerTreeView: vscode.TreeView<TreeNode> | undefined;

/**
 * The fallback icon for a package row: a stack, for the pile of tasks the row
 * opens into.
 *
 * It used to name the runner instead — npm, cargo, make — and that was taken out
 * once because a column of different glyphs made the headings compete with the
 * rows under them. `groupIcons` is where that judgement now lives: `type` puts
 * the ecosystem's glyph back on every heading in its own colour, which is what
 * tells a Node row from a Rust one in a polyglot repository, and `uniform` is
 * this icon on all of them, the old look one setting away.
 */
const GROUP_ICON = 'layers';

/**
 * What each ecosystem is called, what it is drawn as, and the colour that glyph
 * is tinted.
 *
 * Codicons wherever one exists, and nothing else: an icon given as a `Uri` — a
 * brand logo of our own — cannot resolve a `ThemeColor`, so six tinted codicons
 * beside a handful of fixed-colour SVGs would read as a bug rather than a set.
 * Where no codicon is brand-shaped (nothing is, for npm, Rust, Go, PHP, Deno or
 * Docker) the nearest honest glyph is used: Rust's own mark *is* a gear, and a
 * shell script is `terminal-bash`. Docker gets the crate — the font carries no
 * whale, no cube and no container, and of what it does carry a box is what the
 * industry draws a container as. `package`, the other box, is npm's.
 *
 * `mise` keeps its own casing, which is the rule the rest of the tree already
 * applies to the names a project gives itself.
 *
 * The glyph and nothing else. A colour per ecosystem was tried and taken out:
 * every heading in the tree then wore a colour nobody chose, which is the one
 * job the paint is for — and a column of eleven tints turned the headings into
 * the loudest thing on screen. A heading is tinted when somebody paints it, and
 * otherwise wears the title colour like every other heading.
 */
const ECOSYSTEMS: Record<Ecosystem, { label: string; icon: string }> = {
  node: { label: 'Node', icon: 'package' },
  rust: { label: 'Rust', icon: 'gear' },
  python: { label: 'Python', icon: 'snake' },
  make: { label: 'Make', icon: 'tools' },
  just: { label: 'Just', icon: 'list-ordered' },
  task: { label: 'Task', icon: 'tasklist' },
  go: { label: 'Go', icon: 'symbol-event' },
  php: { label: 'PHP', icon: 'globe' },
  mise: { label: 'mise', icon: 'versions' },
  docker: { label: 'Docker', icon: 'archive' },
  shell: { label: 'Shell', icon: 'terminal-bash' },
};

/**
 * The glyph a shell row wears when no category has claimed it: the terminal its
 * file is actually read by.
 *
 * A `play` triangle on `entrypoint.sh` said only "this is a task", which every
 * row in the tree already is. The extension is the one thing a script file says
 * about itself for certain, and the codicon font carries the three shells that
 * matter — so a `.sh` reads as bash, a `.ps1` as PowerShell and a `.bat` as the
 * command prompt, at a glance and down a column.
 *
 * `.zsh` and `.ksh` take the plain terminal: the font has no glyph of their own,
 * and wearing bash's would name the wrong shell.
 */
const SHELL_ICONS: Readonly<Record<string, string>> = {
  sh: 'terminal-bash',
  bash: 'terminal-bash',
  zsh: 'terminal',
  ksh: 'terminal',
  ps1: 'terminal-powershell',
  bat: 'terminal-cmd',
  cmd: 'terminal-cmd',
};

/** The terminal a shell row is read by, for the rows that are shell scripts. */
function shellIcon(script: ScriptEntry): string | undefined {
  if (script.kind !== 'shell') {
    return undefined;
  }
  const name = path.posix.basename((script.file ?? script.manifest).path).toLowerCase();
  const dot = name.lastIndexOf('.');
  // An extension nobody has a glyph for is still a script run in a terminal.
  return (dot > 0 ? SHELL_ICONS[name.slice(dot + 1)] : undefined) ?? 'terminal';
}

/**
 * The manifests that make a folder a project, and so can take the compose files
 * and script folders around them in under their own heading.
 *
 * The six that give a project a name of its own. A Makefile, a justfile, a
 * Taskfile and a mise.toml are task runners rather than statements about what
 * the folder *is*, so a folder holding only one of those is not a project a
 * compose file could belong to, and the compose file stays a heading of its own.
 */
const HOST_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'npm',
  'deno',
  'composer',
  'cargo',
  'pyproject',
  'go',
]);

/**
 * Whether a heading describes what is *around* a project rather than a project.
 *
 * These are the reason the tree has a second level at all in `flat` mode: a
 * compose file, a Dockerfile and a `scripts/` folder describe how a project is
 * shipped rather than what it is, and reading them as siblings of the packages
 * they serve put a column of infrastructure between one project and the next.
 */
function attachable(kind: SourceKind | undefined): boolean {
  return kind === 'docker-compose' || kind === 'dockerfile' || kind === 'shell';
}

/** The id an ecosystem's parent row is built with, and files its fold and colour under. */
function ecosystemId(ecosystem: Ecosystem): string {
  return `group:eco:${ecosystem}`;
}

/**
 * Whether a manifest heading wears the icon its own file has in the user's file
 * icon theme, or the one stack glyph every heading used to wear.
 *
 * Parent rows are not covered either way: an ecosystem row names no file, so it
 * keeps the codicon `ECOSYSTEMS` gives it in both modes.
 */
function typeIcons(): boolean {
  return (
    vscode.workspace.getConfiguration('taskRunnerUltimate').get<string>('groupIcons', 'type') ===
    'type'
  );
}

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
      // An ecosystem parent moves the whole run under it. The payload keeps
      // `GROUPS_SCOPE`, so `handleDrop` dispatches exactly as it did; the extra
      // `block` is what tells the two gestures apart once it gets there.
      const parent = source[0];
      if (parent.ecosystem && !parent.ref) {
        const refs = parent.children.flatMap((child) =>
          child.kind === 'group' && child.ref ? [child.ref] : [],
        );
        if (refs.length === 0) {
          return;
        }
        const payload = new vscode.DataTransferItem(
          JSON.stringify({ scope: GROUPS_SCOPE, refs, block: parent.ecosystem }),
        );
        for (const mime of DRAG_MIMES) {
          transfer.set(mime, payload);
        }
        hint(
          `$(move) Moving ${ECOSYSTEMS[parent.ecosystem].label} — drop on another ecosystem to reorder`,
        );
        return;
      }

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
      const inside =
        hierarchical() && first.ecosystem ? ` inside ${ECOSYSTEMS[first.ecosystem].label}` : '';
      hint(
        first.hidden
          ? `$(move) Moving ${what} — drop on any package outside hidden to bring it back`
          : first.carried
            ? // In the pile because its project is, and the only place it goes is
              // among the rows it shares that project with. Saying so beats the
              // line below, which offers a way out and a pile it is already in.
              `$(move) Moving ${what} — drop on another row in the same package to reorder`
            : `$(move) Moving ${what} — drop on another package${inside} to reorder, or on hidden to put it away`,
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

    let payload: { scope?: unknown; refs?: unknown; block?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }
    const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
    const dragged = Array.isArray(payload.refs) ? payload.refs.filter((ref): ref is string => typeof ref === 'string') : [];
    // Present only when an ecosystem row was the thing dragged, and checked
    // against the table rather than trusted: it arrives as JSON off a clipboard.
    const block = ALL_ECOSYSTEMS.find((name) => name === payload.block);
    if (!scope || dragged.length === 0) {
      clearHint();
      return;
    }

    if (scope === GROUPS_SCOPE) {
      await dropGroups(dragged, target, block);
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
    const at = anchor ? dropIndex(current, rest, moved, anchor) : rest.length;
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
async function dropGroups(dragged: string[], target: TreeNode, block?: Ecosystem): Promise<void> {
  if (target.kind === 'group' && target.id === HIDDEN_GROUP_ID) {
    await setGroupsHidden(dragged, true);
    return;
  }

  const buried = new Set(hiddenRefs());
  const nested = hierarchical();
  const hosts = nested ? new Map<string, string>() : await groupHosts();
  // Whether a heading is in the pile — put there by hand, or drawn inside a
  // project that was. Only the first has a ref in the store, and a drop aimed at
  // either of them means the same thing to the hand that made it.
  const pile = (ref: string | undefined): boolean =>
    ref !== undefined && (buried.has(ref) || buried.has(hosts.get(ref) ?? ''));
  const ecosystems = nested ? await groupEcosystems() : new Map<string, Ecosystem>();
  const current = await groupScopes();
  const moved = dragged.filter((ref) => current.includes(ref));
  // Where the drop landed, as an ecosystem: a heading carries its own, a parent
  // row is one outright, and a task row names the heading it sits under.
  const where =
    target.kind === 'group'
      ? target.ecosystem
      : target.kind === 'script' && !target.inFavorites
        ? ecosystems.get(groupRef(target.script))
        : undefined;

  if (block) {
    // Every heading of this ecosystem, and not only the ones the parent row was
    // drawing. A hidden package keeps its slot in the saved order and the run's
    // rank is read off its first member, so leaving one behind would hold the
    // whole block where it was and the drag would appear to do nothing.
    const run = current.filter((ref) => ecosystems.get(ref) === block);
    if (run.length === 0 || !where || where === block) {
      clearHint();
      return;
    }
    const rest = current.filter((ref) => !run.includes(ref));
    // The first heading of the run that was dropped on: a block takes that run's
    // place, the way a package takes another package's.
    const anchor = current.find((ref) => ecosystems.get(ref) === where);
    const at = anchor ? dropIndex(current, rest, run, anchor) : rest.length;
    await saveGroupOrder([...rest.slice(0, at), ...run, ...rest.slice(at)]);
    clearHint();
    repaint();
    return;
  }

  const anchor = anchorGroup(target);
  if (pile(anchor)) {
    await setGroupsHidden(dragged, true);
    return;
  }
  if (moved.length === 0) {
    clearHint();
    return;
  }

  // In `ecosystem` mode a heading cannot leave the run it belongs to. Allowing
  // it would splice the ref into the flat order and `groupedByEcosystem` would
  // pull it straight back, so the drop would read as nothing having happened —
  // which is worse than a refusal, and a refusal is all there is: the API gives
  // an extension no way to grey out a target under the mouse.
  // In `flat` mode the compose files and script folders are drawn inside the
  // project they belong to, and that placement is read off the paths rather than
  // stored — so a drop that would take one out of its project cannot be
  // honoured: the order would be rewritten and the next repaint would put the
  // row straight back. Said out loud for the same reason the ecosystem rule is.
  // A heading on its way out of the pile is not drawn inside anything yet, so
  // the rule about staying inside a project has nothing to say about it — and
  // saying it anyway refused the one gesture that brings such a heading back.
  // Per row and not per gesture: one heading on its way out of the pile used to
  // lift the rule off every other heading travelling with it, and a multi-select
  // spanning the pile and the list could then splice a compose file out of its
  // project — an order the next repaint undoes, which is the "nothing happened"
  // this refusal exists to avoid.
  // By ref in the store and not by `pile`: a heading that only travelled with
  // its project cannot come back on its own, so the exemption is not its to
  // take. The rule below is what tells it so, instead of a drop that writes an
  // order and changes nothing on screen.
  const settling = moved.filter((ref) => !buried.has(ref));
  if (!nested && anchor && settling.length > 0) {
    const inside = (ref: string) => hosts.get(ref) ?? '';
    const from = new Set(settling.map(inside));
    if (from.size > 1 || !from.has(inside(anchor))) {
      hint(
        '$(circle-slash) Not a drop target — this row is drawn inside its project, and moves among the rows there',
      );
      return;
    }
  }

  // Every dragged heading, not only the first: one gesture can carry a
  // multi-select spanning two runs, and the refs from the other one would be
  // spliced into a run `groupedByEcosystem` pulls them straight back out of.
  const homes = new Set(moved.map((ref) => ecosystems.get(ref)));
  const [home] = homes;
  if (nested && where && (homes.size > 1 || home !== where)) {
    hint(
      homes.size > 1
        ? '$(circle-slash) Not a drop target — packages from two ecosystems do not move together'
        : `$(circle-slash) Not a drop target — a package moves inside ${home ? ECOSYSTEMS[home].label : 'its own ecosystem'}, or onto hidden`,
    );
    return;
  }

  const rest = current.filter((ref) => !moved.includes(ref));
  let at: number;
  if (anchor) {
    // Dropped on itself, or on a heading travelling with it: nothing to work out.
    if (moved.includes(anchor)) {
      clearHint();
      return;
    }
    // The same rule a task drop follows: the dragged rows take the target's place.
    at = dropIndex(current, rest, moved, anchor);
  } else if (nested && where && where === home) {
    // Dropped on the ecosystem's own row, which has no slot of its own to take:
    // the end of its run, the way a task dropped on its heading means the end of
    // the list.
    const last = rest.filter((ref) => ecosystems.get(ref) === where).pop();
    at = last ? rest.indexOf(last) + 1 : rest.length;
  } else {
    hint('$(circle-slash) Not a drop target — a package moves between packages, or onto hidden');
    return;
  }

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

/**
 * The project each compose file and script folder is drawn inside of, by ref —
 * `attachedHosts` read off the scan instead of off the rows.
 *
 * Over the scan because a drop has to reason about headings the tree is not
 * drawing: one in the hidden pile keeps its slot in the order a drop rewrites,
 * and one inside a put-away project is still drawn inside it.
 */
async function groupHosts(): Promise<Map<string, string>> {
  // One row settles a heading's kind and its folder, so the first of each is all
  // the walk needs.
  const sample = new Map<string, ScriptEntry>();
  for (const script of await savedOrder()) {
    const ref = groupRef(script);
    if (!sample.has(ref)) {
      sample.set(ref, script);
    }
  }
  return attachedHosts(
    [...sample].map(([ref, script]) => ({ ref, at: manifestFolder(script), kind: script.kind })),
  );
}

/**
 * The ecosystem each heading in the saved order belongs to. Read off the scan
 * rather than off the tree, because a drop has to place a heading the tree may
 * not be drawing — one inside the hidden pile keeps its slot in this order.
 */
async function groupEcosystems(): Promise<Map<string, Ecosystem>> {
  const map = new Map<string, Ecosystem>();
  for (const script of await savedOrder()) {
    map.set(groupRef(script), ecosystemOf(script.kind));
  }
  return map;
}

/**
 * Where a set of dragged refs lands when it is dropped on `anchor`.
 *
 * The rule every drop in this tree follows: the dragged rows take the target's
 * place — dropped on a row above they land in front of it, on a row below they
 * land behind it.
 *
 * The arithmetic has to be done against the list the moved rows have already
 * been taken out of, plus one when any of them came from above the anchor.
 * Reading the index straight out of `current` overshoots by however many of them
 * sat in front of it: invisible while that is one row, and wrong the moment it
 * is two — which for a whole ecosystem block is the ordinary case, not the
 * exception.
 */
function dropIndex(
  current: ReadonlyArray<string>,
  rest: ReadonlyArray<string>,
  moved: ReadonlyArray<string>,
  anchor: string,
): number {
  const target = current.indexOf(anchor);
  const above = moved.some((ref) => current.indexOf(ref) < target);
  const landing = rest.indexOf(anchor);
  return landing < 0 ? rest.length : Math.min(landing + (above ? 1 : 0), rest.length);
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
 * two — and for those the store holds the exception the other way round: a ref
 * present there means the user opened it, not that they shut it. One store, one
 * meaning per group, and the default each group wants.
 *
 * HIDDEN is the one whose whole point is to be out of the way. A compose file is
 * the other: it is seven rows for one file where a package.json is seven rows
 * for seven scripts, most of them — `build`, `logs`, `ps` — the ones you go
 * looking for rather than press, and in `flat` mode they sit inside a project
 * heading that has its own tasks to show first. Shut, it is one line saying
 * which stack is here, which is what a heading is for.
 */
function startsOpen(node: TreeNode): boolean {
  if (node.kind !== 'group') {
    return true;
  }
  return node.id !== HIDDEN_GROUP_ID && node.source !== 'docker-compose';
}

/**
 * Whether a heading is drawn as one row rather than as a folder of rows.
 *
 * Two manifests are the thing being run rather than a list of things to run. A
 * compose file *is* the stack, and a Dockerfile *is* the image: `build` is the
 * one action every Dockerfile has, and the rest — `run`, `push`, one `build:
 * <stage>` per named stage — are the variations on it, not siblings of it. Drawn
 * as a folder, a `Dockerfile` cost a fold and a row of its own to say a word its
 * heading had already said.
 *
 * So both come back with no children at all (see `getChildren`), and what the
 * rows underneath used to offer is on the heading itself: the bare action on ▶,
 * the rest behind the menu button beside it.
 */
function isFileItem(node: TreeNode): boolean {
  return node.kind === 'group' && node.source !== undefined && isItemKind(node.source);
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
      return node.kind === 'group' && !isFileItem(node) ? node.children : [];
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
      // `NO_TINT` is a row that took one of these URIs for the file name in it
      // and nothing else — an unpainted row wearing an icon from the file icon
      // theme — and it must come back as plainly as a row with no URI at all.
      return color && color !== NO_TINT ? { color: new vscode.ThemeColor(color) } : undefined;
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
 * has already applied by the time the rows get here. The groups themselves never
 * move: the scan order and the user's drags are the only things that place them,
 * so starting a script in the third package does not shuffle the tree under the
 * hand that started it.
 */
function buildTreeRoots(scripts: ScriptEntry[]): TreeNode[] {
  const groups: Array<TreeNode & { kind: 'group' }> = [];
  const byManifest = new Map<string, (typeof groups)[number]>();
  const crowded = crowdedFolders(scripts);
  const colliding = collidingHeadings(scripts, crowded);

  for (const script of scripts) {
    const key = script.manifest.toString();
    let group = byManifest.get(key);
    if (!group) {
      // A folder with a second manifest in it — a Cargo.toml beside a Makefile —
      // has two headings that would otherwise name the same folder, so there the
      // file name is what the heading leads with instead.
      //
      // A compose file always does, crowded folder or not: a folder can hold
      // `docker-compose.yml` and `docker-compose.dev.yml` at once, and the
      // `name:` inside them is as often as not the same word. A Dockerfile is
      // the same case with none of the doubt — `Dockerfile` beside
      // `Dockerfile.dev` names nothing at all, so the folder would be both.
      const shared =
        crowded.has(manifestFolder(script)) ||
        script.kind === 'docker-compose' ||
        script.kind === 'dockerfile';
      group = {
        kind: 'group',
        id: `group:${key}`,
        label: manifestTitle(script),
        detail: packagePath(script),
        // The directory, and never the file — with one exception, which is the
        // one thing the bullet is there for.
        //
        // Once the heading leads with a file name, repeating it after the bullet
        // said nothing twice — `compose.yaml • compose.yaml`. What the eye wants
        // there is where the file lives, and the full path keeps its place in
        // the tooltip, which is what `detail` above is for.
        //
        // The exception is two headings in one folder that lead with the *same*
        // text, which is what a napi-rs, neon, wasm-pack or maturin package is:
        // a Cargo.toml beside a package.json, both declaring the same name.
        // Neither row says anything the other does not, and the manifest path is
        // the only thing left that differs — `mylib • crates/mylib/Cargo.toml`
        // beside `mylib • crates/mylib/package.json`. A heading that already
        // differs is left alone: `engine • svc` beside `Makefile • svc` is two
        // rows nobody can confuse, and a path on both would be noise.
        //
        // A script folder takes neither half. It is drawn as its own path,
        // whole, with nothing in front of the bullet: `scripts • apps/web` put
        // the one word all of these rows share where the eye looks first and the
        // half that tells them apart behind it, so a **Shell** parent held a
        // column of `scripts`, `scripts`, `scripts` to be read by their tails.
        // The path is the name here — which is what the dropdown has called
        // these rows all along.
        //
        // `ecosystem` mode is where that row is drawn; in `flat` mode a
        // project's script folders are one `shell` row by the time the tree has
        // them, and that row is named rather than pathed. See `attachToHosts`.
        folder: script.file
          ? undefined
          : colliding.has(headingKey(script, shared))
            ? packagePath(script)
            : packageFolder(script),
        place: script.file ? packagePath(script) : packageHeading(script, shared),
        icon: GROUP_ICON,
        scope: groupRef(script),
        ref: groupRef(script),
        manifest: script.manifest,
        // A shell group's manifest *is* a directory — see `collectShellScripts`
        // — so the row carries it as one as well, and Open Manifest reveals the
        // folder rather than failing to open it as a document.
        directory: script.file ? script.manifest : undefined,
        ecosystem: ecosystemOf(script.kind),
        source: script.kind,
        at: manifestFolder(script),
        children: [],
      };
      byManifest.set(key, group);
      groups.push(group);
    }

    group.children.push({ kind: 'script', script });
  }

  // A heading the user put away leaves the list it was in and goes to the pile at
  // the bottom, taking its tasks with it. It keeps its slot in the saved order all
  // the while, so the eye that brings it back puts it back where it was.
  //
  // It takes what is drawn inside it along. In `flat` mode a compose file and a
  // script folder are rows inside a project rather than beside one, and putting
  // the project away is putting that folder away: the rows go with it, nested as
  // they were. Left behind they surfaced at the root, level with the packages —
  // out of the folder the eye had just put away, and in the one place this mode
  // never draws them.
  const buried = new Set(hiddenRefs());
  const hosts = hierarchical()
    ? new Map<string, string>()
    : attachedHosts(
        groups.flatMap((group) =>
          group.ref !== undefined && group.at !== undefined && group.source !== undefined
            ? [{ ref: group.ref, at: group.at, kind: group.source }]
            : [],
        ),
      );
  const inPile = (group: (typeof groups)[number]): boolean =>
    group.ref !== undefined && (buried.has(group.ref) || buried.has(hosts.get(group.ref) ?? ''));
  const shown = groups.filter((group) => !inPile(group));
  const away = groups.filter((group) => inPile(group));

  // The saved order, whole: what is running inside a group is no reason to move
  // the group, here or in the picker. Inside one nothing moves either, unless
  // `pinRunningTasks` lifts the rows.
  //
  // In `ecosystem` mode the same list is drawn one level down, under a parent
  // row per ecosystem. `savedOrder` has already gathered each ecosystem's groups
  // into one run, so this only has to fold the runs it is handed — which is why
  // the tree and the dropdown cannot disagree about the order.
  //
  // A single manifest gets no parent, mirroring the rule `buildItems` follows
  // for package separators: one heading over one heading says nothing.
  const roots: TreeNode[] = hierarchical()
    ? // A single manifest under a parent row of its own says nothing, so the one
      // group stands at the root by itself. `attachToHosts` is the other mode's
      // second level and has nothing to do here either way.
      shown.length > 1
      ? parentRows(shown)
      : [...shown]
    : attachToHosts(shown);

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

  // Favorites sit above everything: a pinned list is only worth pinning if it
  // does not move.
  //
  // The scripts stay in their own package group as well: this is a second way
  // in, not a way out of the package it lives in. What tells the two rows apart
  // is the dimmed text, which on a starred row names the package it came from.
  //
  // Starring already writes an order, so these rows are draggable in their own
  // right: the drag rewrites the starred list instead of a manifest's order.
  //
  // How they are drawn is the one thing the two modes disagree about.
  //
  // In `flat` mode they are rows at the root — a heading over the two or three
  // tasks you run all day is a fold to open before you can click them, and the
  // shortest list in the tree is the one that least needs a lid.
  //
  // In `ecosystem` mode every other root row is a heading, so bare task rows
  // above them read as tasks belonging to the first ecosystem rather than as a
  // list of their own. There they get a heading like everything else, pinned at
  // the top and open by default: the lid costs nothing when it starts open, and
  // it is what says where the starred list ends and Node begins.
  const favorites = runningFirst(favoriteScripts(scripts));
  const starred = favorites.map((script): TreeNode => ({ kind: 'script', script, inFavorites: true }));
  if (hierarchical() && starred.length > 0) {
    roots.unshift({
      kind: 'group',
      id: FAVORITES_GROUP_ID,
      label: `Favorites (${starred.length})`,
      icon: 'star-full',
      // The list the rows inside it belong to, which is what makes the heading
      // itself a drop target: a task dropped on it is starred at the end of the
      // list, the way one dropped on a package heading lands at the end of that
      // package. See `dragScope` and `handleDrop`.
      scope: FAVORITES_SCOPE,
      children: starred,
    });
  } else {
    roots.unshift(...starred);
  }

  // And the pile itself, last on the list and shut by default: a group whose
  // point is to be out of the way has not moved out of the way if it opens
  // itself. It is a drop target too — dragging a heading onto it puts it away,
  // and dragging one back out onto any other heading brings it back.
  //
  // Its children stay manifest groups even in `ecosystem` mode. A pile of
  // put-away packages routinely spans ecosystems, so parenting it would mostly
  // produce parent rows holding one child each — and `shown` and `away` are
  // split above, so a parent's count never includes anything hidden.
  //
  // They are nested by the same walk the list above uses, though, so a project
  // in the pile is still the folder it was on the way in: opening the pile shows
  // what was put away, not its contents tipped out beside it. `ecosystem` mode
  // nests nothing anywhere, so there the pile is the flat list it always was.
  if (away.length > 0) {
    const pile = hierarchical() ? away : attachToHosts(away, HIDDEN_GROUP_ID);
    roots.push({
      kind: 'group',
      id: HIDDEN_GROUP_ID,
      // What the fold opens onto, and not how many refs the store holds: a row
      // travelling with its project is behind that project rather than beside
      // it, and counting it here promised more rows than the pile has.
      label: `hidden (${pile.length})`,
      icon: 'eye-closed',
      hidden: true,
      children: pile.map(function putAway(node: TreeNode): TreeNode {
        // The eye that brings a heading back belongs on the ones the user put
        // here, and on nothing else: a row that only travelled with its project
        // comes back when the project does, and a button that cannot do that is
        // worse than no button at all.
        return node.kind !== 'group'
          ? node
          : {
              ...node,
              ...(node.ref !== undefined && buried.has(node.ref)
                ? { hidden: true }
                : { carried: true }),
              children: node.children.map(putAway),
            };
      }),
    });
  }

  return roots;
}

/**
 * The compose files and script folders folded in under the project each of them
 * belongs to — the `flat` mode's own second level.
 *
 * A `docker-compose.yml` and a `scripts/` folder describe the thing around a
 * project rather than a thing beside it: they reach across every folder under
 * the project root, which is exactly why a heading of their own, level with the
 * packages, read as infrastructure wedged between one package and the next. So
 * each of them looks for the nearest folder at or above its own that holds a
 * project manifest, and goes inside that project's heading.
 *
 * Nothing is stored. The relationship is the paths, so it is computed here every
 * time and there is no state to go stale, prune or reset — which is also why a
 * drag cannot move one of these out of its project: see `dropGroups`.
 *
 * In `ecosystem` mode this does not run at all. There the question the tree
 * answers is "what kind of thing is this", and the answer for a compose file is
 * Docker, not the package it happens to serve.
 *
 * It runs twice: once over the headings on the list, once over the ones in the
 * pile. `rootKey` is what keeps the two `shell` buckets apart — one row per
 * place, since a tree cannot hold two rows under one id, and the bucket with no
 * project above it is the only one both calls could name the same way.
 */
function attachToHosts(groups: Array<TreeNode & { kind: 'group' }>, rootKey = ''): TreeNode[] {
  const hosts = new Map<string, TreeNode & { kind: 'group' }>();
  for (const group of groups) {
    if (group.at !== undefined && group.source && HOST_KINDS.has(group.source) && !hosts.has(group.at)) {
      hosts.set(group.at, group);
    }
  }

  const roots: TreeNode[] = [];
  // The script folders of one project, gathered by the project they landed in —
  // the ones with no project above them share the bucket keyed by nothing. The
  // row goes in where the first of them would have gone, and is filled below
  // once it is known how many folders it stands for.
  type Group = TreeNode & { kind: 'group' };
  const folders = new Map<string, { row: Group; host?: Group; members: Group[] }>();

  for (const group of groups) {
    const host = attachable(group.source) ? hostOf(group.at, hosts) : undefined;
    if (group.source === 'shell') {
      const key = host?.id ?? rootKey;
      let folder = folders.get(key);
      if (!folder) {
        folder = { row: shellFolder(key), host, members: [] };
        folders.set(key, folder);
        (host ? host.children : roots).push(folder.row);
      }
      folder.members.push(group);
      continue;
    }
    if (!host) {
      roots.push(group);
      continue;
    }
    host.children.push(insideHost(group, host));
  }

  for (const { row, host, members } of folders.values()) {
    const [only] = members;
    if (members.length === 1 && only) {
      // One folder on disk behind the row, so the row is that folder: it keeps
      // the ref, the path and the drag scope it had, and everything those carry
      // — rename, hide, Open Folder, a colour, an icon, a saved fold. `shell` is
      // only what it is called.
      Object.assign(row, {
        label: only.label,
        detail: only.detail,
        ref: only.ref,
        scope: only.scope,
        manifest: only.manifest,
        directory: only.directory,
        at: only.at,
      });
      row.children.push(...only.children);
    } else {
      // Several folders in one row, so each row says which it came from — `bin`
      // and `scripts` both hold a `build.sh` often enough. A script in the
      // project's own folder has no path to name and says nothing.
      for (const member of members) {
        // The folder's own name, which for a script folder is what `label`
        // holds: `place` is the whole path on these rows, and a dimmed column
        // repeating the path of a row that is right there says nothing.
        const origin = host ? insideOf(member, host) : member.label;
        row.children.push(
          ...member.children.map((child) =>
            child.kind === 'script' && origin ? { ...child, origin } : child,
          ),
        );
      }
    }
    // How many scripts are behind the fold — in the label, since the decoration
    // that tints a row tints a description with it. Every other heading is named
    // by a file or a package and counts nothing; this one is named after what it
    // holds, and how much of it is the rest of that sentence. The name it
    // restores to on a rename is untouched — that is `label`, and this is the
    // half of the heading the row shows.
    //
    // Brackets rather than the parentheses an ecosystem row uses, and nothing at
    // all for a single script: `shell [1]` is a number that can only ever be one
    // thing, counted where there was nothing to count.
    const held = row.children.length;
    row.place = held > 1 ? `shell [${held}]` : 'shell';
  }
  return roots;
}

/**
 * The `shell` heading a project's script folders are drawn as, in `flat` mode.
 *
 * One row and not one per folder: `scripts/`, `bin/` and `tools/ci` under one
 * project are three headings to fold, paint and scroll past, all of them saying
 * the same thing — that there are shell scripts here. What is worth telling
 * apart is a script from a task, and that is the row, not the heading.
 *
 * It is built the way an ecosystem parent row is — no `ref`, no `scope`, no
 * `manifest` — so rename and hide stay off a row that names nothing on disk,
 * while fold, colour, icon and stop-all follow from `node.id` exactly as they do
 * there. A bucket holding a single folder is that folder again by the time it is
 * drawn: see `attachToHosts`.
 *
 * `ecosystem` mode files the same folders under **Shell** instead, which is the
 * same idea one level up, so this does not run there.
 */
function shellFolder(key: string): TreeNode & { kind: 'group' } {
  return {
    kind: 'group',
    id: `group:shell:${key}`,
    label: 'shell',
    place: 'shell',
    // The stack every heading falls back to under `groupIcons: 'uniform'`; the
    // terminal it wears otherwise is `ECOSYSTEMS.shell` — see `treeItemFor`.
    icon: GROUP_ICON,
    ecosystem: 'shell',
    source: 'shell',
    children: [],
  };
}

/** The nearest project at or above a folder, walking up as far as the paths go. */
function hostOf<T>(at: string | undefined, hosts: ReadonlyMap<string, T>): T | undefined {
  let folder = at;
  while (folder !== undefined) {
    const host = hosts.get(folder);
    if (host) {
      return host;
    }
    const parent = path.posix.dirname(folder);
    // `dirname('/')` is `/`, which is where the walk runs out of workspace.
    folder = parent === folder ? undefined : parent;
  }
  return undefined;
}

/**
 * The project each compose file and script folder belongs to, by ref — the one
 * walk `orderedByHost`, `buildTreeRoots` and `groupHosts` all read, so the saved
 * order, the tree and the drop arithmetic cannot disagree about what is drawn
 * inside what.
 *
 * Hiding has nothing to do with it. A project that is put away still hosts what
 * sits under it, which is what takes its compose files and script folders into
 * the pile along with it. Left out, they came back to the root the moment their
 * project went away — level with the packages, which is the one place `flat`
 * mode never draws them, and out of the folder the eye had just put away whole.
 */
function attachedHosts(
  entries: ReadonlyArray<{ ref: string; at: string; kind: SourceKind }>,
): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const entry of entries) {
    if (HOST_KINDS.has(entry.kind) && !hosts.has(entry.at)) {
      hosts.set(entry.at, entry.ref);
    }
  }

  const attached = new Map<string, string>();
  for (const entry of entries) {
    const host = attachable(entry.kind) ? hostOf(entry.at, hosts) : undefined;
    if (host !== undefined && host !== entry.ref) {
      attached.set(entry.ref, host);
    }
  }
  return attached;
}

/**
 * The same heading, said as something inside a project rather than beside one.
 *
 * The path shrinks to where it sits relative to that project — the heading above
 * has already named everything the two have in common, and repeating it is the
 * noise the tree avoids by not printing the workspace name on every row.
 *
 * The compose files and the Dockerfiles are what reaches this: a project's script
 * folders are one `shell` row by the time they are drawn, and that row is named
 * rather than pathed. `insideOf` is the half of this they do use.
 */
function insideHost(
  group: TreeNode & { kind: 'group' },
  host: TreeNode & { kind: 'group' },
): TreeNode & { kind: 'group' } {
  const inside = insideOf(group, host);
  return { ...group, folder: inside || undefined };
}

/**
 * Where a heading sits relative to the project it is drawn inside — empty when
 * that is the project's own folder, which is a path with nothing left to say
 * rather than a missing one.
 */
function insideOf(group: TreeNode & { kind: 'group' }, host: TreeNode & { kind: 'group' }): string {
  return group.at && host.at && group.at.startsWith(`${host.at}/`) ? group.at.slice(host.at.length + 1) : '';
}

/**
 * One row per ecosystem, each holding the manifest groups that belong to it, in
 * the order they were handed over.
 *
 * The row is built with no `ref`, no `scope` and no `manifest`, which is a
 * choice and not an omission: that is the shape OTHER TASKS and the hidden pile
 * already have, and the whole set of affordances follows from it with no code of
 * its own. Fold, colour and icon work through the `node.id` fallbacks
 * `collapseRef`, `colorRef` and `storedIcon` already take. Rename, Hide and Open
 * Manifest stay off — there is no name on disk for a rename to restore, no file
 * to open, and hiding a whole ecosystem is what `sources` does properly.
 *
 * The count rides in the label rather than in a description, because the
 * decoration that tints a row tints its description with it.
 */
function parentRows(groups: Array<TreeNode & { kind: 'group' }>): TreeNode[] {
  const parents = new Map<Ecosystem, TreeNode & { kind: 'group' }>();
  const roots: TreeNode[] = [];

  for (const group of groups) {
    const ecosystem = group.ecosystem;
    // Nothing reaches here without one; a group built without a kind to read
    // stays at the root rather than being filed under a guess.
    if (!ecosystem) {
      roots.push(group);
      continue;
    }
    let parent = parents.get(ecosystem);
    if (!parent) {
      const type = ECOSYSTEMS[ecosystem];
      parent = {
        kind: 'group',
        id: ecosystemId(ecosystem),
        label: type.label,
        icon: type.icon,
        ecosystem,
        children: [],
      };
      parents.set(ecosystem, parent);
      roots.push(parent);
    }
    parent.children.push(group);
  }

  for (const parent of parents.values()) {
    parent.label = `${parent.label} (${parent.children.length})`;
  }
  return roots;
}

/**
 * The URI a row borrows to be two things at once: a resource a decoration can be
 * hung on, and a name a file icon theme can be matched against.
 *
 * Nothing of it is on screen — the row carries its own label, description and
 * tooltip — but the path is not free to be any identity that tells this row from
 * the others: its last segment is read, by the workbench, to decide which icon
 * the row wears.
 *
 * The colour is the first segment and the name is the rest, which is why a row
 * that wants only the name passes `NO_TINT` — a path cannot have an empty first
 * segment without turning into an authority the moment the URI is spelled out.
 */
function decorationUri(color: string, name: string): vscode.Uri {
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${color}/${name}` });
}

/** The colour slot of a row that is only here for the name. See `decorationUri`. */
const NO_TINT = '-';

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
    //
    // And no bullet at all when the path would only repeat the name: a manifest
    // alone in `tools/` is `tools`, not `tools • tools`, and a compose file in
    // the root of a single-folder workspace has no path left to show.
    const heading = node.folder && node.folder !== title ? `${title} • ${node.folder}` : title;
    // Open unless the user has folded this one shut before: a tree you have never
    // touched shows everything it found, and one you have shows it as you left it.
    const item = new vscode.TreeItem(
      heading,
      isFileItem(node)
        ? vscode.TreeItemCollapsibleState.None
        : isCollapsed(node)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
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
    //
    // The ecosystem's own glyph belongs to the parent rows, which stand for an
    // ecosystem and have no file of their own to show. OTHER TASKS and the
    // hidden pile carry no ecosystem and are left exactly as they were.
    //
    // The glyph only. The colour of a heading is either one somebody painted or
    // the one every heading shares; see `ECOSYSTEMS` for why there is no third.
    const type = node.ecosystem && node.ref === undefined ? ECOSYSTEMS[node.ecosystem] : undefined;
    const tint = nodeColor(node) ?? (node.id === HIDDEN_GROUP_ID ? HIDDEN_COLOR : TITLE_COLOR);
    // The path this points at ends in the manifest's own file name — `detail` is
    // the manifest path — which is what lets the file icon theme below find an
    // icon for it while the scheme stays ours. Both halves matter: the scheme
    // keeps our colour off the real file in the Explorer, and the file name is
    // the only thing an icon theme matches on.
    // An icon taken from the file icon theme is worn the same way the manifest's
    // own icon is, and through the same URI: the workbench is shown a name and
    // draws whatever its pack has for it. So the name in this path is the picked
    // one when there is one, and the manifest's own the rest of the time.
    const specimen = storedSpecimen(node.ref ?? node.id);
    item.resourceUri = decorationUri(tint, specimen?.name ?? node.detail ?? node.label);

    // A heading that names something on disk wears that thing's own icon, taken
    // from whichever file icon theme the user runs — the real npm, Rust and
    // Docker marks, which no codicon font carries. The decoration above colours
    // the label and leaves the icon alone, so a painted heading keeps both: its
    // colour on the text and its logo beside it.
    //
    // An icon picked by hand still stands in for it, and `groupIcons: 'uniform'`
    // still puts the one stack glyph on every heading.
    const picked = storedIcon(node.ref ?? node.id);
    // Whether anything under this heading is running, which the icon and the
    // buttons both read. One walk for the two of them.
    const alive = runningScriptsOf(node).length > 0;
    // A folder of shell scripts is the one heading with no file behind it, and a
    // theme can only match on a file name — it used to borrow the theme's folder
    // icon, which said "folder" where the rows inside it say bash, PowerShell and
    // cmd. So it wears the terminal the Shell ecosystem row wears, and follows
    // `groupIcons` like every other heading: `uniform` puts the stack back on it.
    const stock = node.source === 'shell' && typeIcons() ? ECOSYSTEMS.shell.icon : node.icon;
    if (alive && isFileItem(node)) {
      // A compose file and a Dockerfile are the two headings that *are* the thing
      // being run — the stack and the image, which is why ▶ sits on the row — so
      // each spins while any part of it runs, the way a task row does. Any part:
      // one `up: web` of six services is the stack being up as far as that row is
      // concerned, and a `build: deps` is this image being built. Neither row has
      // anything underneath it to show a spinner instead, which is exactly when a
      // heading that cannot say it is busy is a heading you cannot ask.
      //
      // Only these two. Every other heading is a file or a folder that *holds*
      // tasks rather than being one, and a spinner on all of them would be a
      // column of them in a monorepo where one `dev` is running.
      //
      // The spinner wins over an icon picked by hand for the same reason it does
      // on a row: "this one is busy" is the answer to a different question, and
      // it is the answer for as long as it is the one worth finding.
      item.iconPath = runningIcon();
    } else if (specimen) {
      // Picked by hand out of the pack, so it wins over the manifest's own icon
      // and over `groupIcons` alike — the setting decides what an unanswered
      // heading wears, and this heading was answered for.
      item.iconPath = specimenIcon(specimen);
    } else if (!picked && node.ref !== undefined && node.source !== 'shell' && typeIcons()) {
      item.iconPath = vscode.ThemeIcon.File;
    } else {
      const glyph = picked ?? type?.icon ?? stock;
      if (glyph) {
        item.iconPath = new vscode.ThemeIcon(glyph, new vscode.ThemeColor(tint));
      }
    }
    item.id = node.id;
    // Only a heading that names something on disk can be renamed back to it, so
    // the two kinds of group are told apart for the `when` clause that offers it.
    // A put-away heading is told apart from the rest as well: the two eyes are
    // one button in two states, and only one of them can be on a row at a time.
    // `:running` marks a heading with something alive under it, which is what
    // puts the stop-all and restart-all buttons on the row and nowhere else.
    //
    // An ecosystem parent is the third shape: it has no ref, so it is neither
    // renameable nor hideable, but it does hold running rows and so keeps the
    // stop-all and restart-all buttons.
    if (node.ecosystem && !node.ref) {
      item.contextValue = alive ? 'group:eco:running' : 'group:eco';
      return item;
    }
    // A compose row says whether its stack is up: `up` is what Docker last
    // answered — see `containers` — and `down` is everything else, "nobody has
    // asked" included. It is not what puts ▶ and ■ on the row; those are on
    // every compose row, because the file *is* the stack and taking it up or
    // down is the one thing anybody asks of one. The segment is here so a `when`
    // clause can still tell the two apart, and so the shape of a compose context
    // value is the package row's shape with one more state in front of the tail.
    const stack = composeUpNode(node);
    const stacked = stack ? (containersUp(stack.script) ? ':up' : ':down') : '';
    // Three states and not two. `:carried` is a heading the pile holds only
    // because the project it is drawn inside of is put away: it is in there, so
    // Hide has nothing left to do, and it was never put there on its own, so
    // Show has nothing to bring back — see `carried` on the node.
    const put = node.carried ? ':carried' : node.hidden ? ':hidden' : '';
    // A Dockerfile takes a head of its own for the same reason compose has one:
    // the row is a file that is run rather than a package that holds rows, so the
    // package's menu — Run/Stop on a script, the confirmation toggle — is not the
    // menu it wants.
    const head =
      node.source === 'docker-compose'
        ? 'compose'
        : node.source === 'dockerfile'
          ? 'dockerfile'
          : 'group:package';
    // What the file's own action is doing, in the slot compose fills with `:up`
    // and `:down`. A Dockerfile's own action is `build`, and the only thing a
    // `when` clause needs of it is whether *that* is what is running.
    //
    // `:running` cannot answer it. That segment is true when anything under the
    // row is alive, and the commonest thing alive under a Dockerfile is the
    // container `run` started — which has nothing to do with whether the image
    // can be rebuilt. Keying ▶ on `:running` took the rebuild out of the
    // edit-build-restart loop at exactly the point the loop needs it, so the one
    // press ▶ must refuse is the second build over a live one, and that is what
    // this says. `runLead` refuses it again by key, for the press that arrives
    // before the tree has been repainted.
    //
    // It never appears beside `stacked`: `composeUpNode` answers for compose
    // alone and `dockerfileBuildNode` for Dockerfiles alone, so a row has one
    // slot filled or neither.
    const lead = dockerfileBuildNode(node);
    const building = lead && running.has(lead.script.key) ? ':building' : '';
    const state = `${head}${stacked}${building}${put}`;
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
  // Reported by Docker rather than by the task system, and only worth saying
  // when nothing of ours is running — there the spinner is the better answer.
  const up = !isRunning && containersUp(node.script);
  const item = new vscode.TreeItem(displayName(node.script));
  // A starred script is on screen twice, at the top of the list and in its own
  // group. Without ids of its own the tree cannot tell the two rows apart, and
  // the selection would jump between them. Built from the absolute `key` rather than
  // the storage ref, which trades uniqueness for portability.
  item.id = `${node.inFavorites ? 'fav' : 'pkg'}:${node.script.key}`;
  item.description = [
    up ? 'up' : undefined,
    node.origin,
    scriptDescription(node.script, node.inFavorites),
  ]
    .filter(Boolean)
    .join(' · ');
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
  // An icon out of the file icon theme is not a glyph we hold, so it cannot come
  // back from `iconFor` with the rest: it is a name on the row's URI below and a
  // `ThemeIcon.File` here. The spinner still wins over it, for the reason it wins
  // over every other picked icon — a running row is answering a different
  // question — which is why this asks for one only while the row is idle.
  const specimen = isRunning ? undefined : storedSpecimen(scriptRef(node.script));
  item.iconPath = specimen ? specimenIcon(specimen) : iconFor(node.script, isRunning, tint, up);
  // A painted task carries the same decoration trick the headings do, which is
  // the only way a tree label takes a colour at all. The description goes with it
  // — the decoration lands on the whole resource label and `.label-description`
  // has only an opacity of its own — which is the colour on the row rather than
  // on a dot beside it, and is what painting one was for. Unpainted rows are left
  // without a resourceUri, so nothing about them changes.
  //
  // A row wearing a pack icon takes one whether it was painted or not: that URI
  // is where the name lives that the workbench draws the icon from. `NO_TINT`
  // keeps an unpainted row unpainted.
  if (tint || specimen) {
    item.resourceUri = decorationUri(tint ?? NO_TINT, specimen?.name ?? scriptRef(node.script));
  }
  // Five independent axes in one value, matched a piece at a time by the
  // `when` clauses in contributes.menus. Each pair is spelled so that neither
  // half is a substring of the other at a `:` boundary — `:fav:` cannot be found
  // inside `:nofav:` — which is what lets one axis be matched without the four
  // around it having to be written out.
  // `up` rides on the first axis rather than taking one of its own: the last
  // axis is matched with a `$` anchor, and a segment appended after it would
  // stop every one of those clauses matching at all. An axis added later goes in
  // front of that last one instead, where the `.+` of `/^script:.+:confirm$/`
  // swallows it — which is where `shell` went.
  item.contextValue = [
    'script',
    isRunning ? 'running' : up ? 'up' : 'idle',
    isFavorite(node.script) ? 'fav' : 'nofav',
    // What kind of file the row runs, which is what puts Add to Terminal on the
    // shell rows and nowhere else. It goes here rather than after `confirm`
    // because that one is matched with a `$` anchor — see below.
    node.script.kind === 'shell' ? 'shell' : 'task',
    // The last axis, and absent altogether on a row whose file the tree draws as
    // one item — which is the whole of how neither half of the toggle reaches
    // one. Both clauses that offer it end in `:confirm$` or `:noconfirm$`, so a
    // value that simply stops here matches neither, and the menu is one entry
    // shorter rather than showing a switch for a row that never asks. It reaches
    // a starred Dockerfile action, which is the one place such a row is still
    // drawn. See `needsConfirmation`.
    ...(isItemKind(node.script.kind)
      ? []
      : [needsConfirmation(node.script) ? 'confirm' : 'noconfirm']),
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

// --- containers --------------------------------------------------------------

/**
 * What Docker last said about each compose file, by manifest URI: the services
 * it reported up.
 *
 * Asked for rather than watched. A background poll would mean a process per
 * compose file on a timer, which is a cost every workspace would pay for a
 * question most of them never ask — so this is filled by the Check Containers
 * command and refreshed after a compose task of ours ends, and is empty until
 * then. An empty map is not "nothing is running"; it is "nobody has asked".
 */
const containers = new Map<string, Set<string>>();

/** The service an `up` row stands for, or nothing for the row that means all of them. */
function composeService(script: ScriptEntry): string | undefined {
  const at = script.name.indexOf(': ');
  return script.name.slice(0, at < 0 ? undefined : at) === 'up' && at > 0
    ? script.name.slice(at + 2)
    : undefined;
}

/** Whether a row is one of the two that stand for containers being up. */
function isComposeUp(script: ScriptEntry): boolean {
  return script.kind === 'docker-compose' && (script.name === 'up' || script.name.startsWith('up: '));
}

/**
 * Whether Docker last reported containers up for this row — the whole file for a
 * bare `up`, one service for an `up: <service>`.
 */
function containersUp(script: ScriptEntry): boolean {
  if (!isComposeUp(script)) {
    return false;
  }
  const reported = containers.get(script.manifest.toString());
  if (!reported) {
    return false;
  }
  const service = composeService(script);
  return service ? reported.has(service) : reported.size > 0;
}

/**
 * The words in front of the subcommand on an `up` row — the program, the `-f`s,
 * and nothing else. Read back off a row rather than rebuilt, so the override
 * file and the `dockerCompose` spelling the parser settled on are the ones the
 * probe uses too.
 *
 * Only an `up` row, and that is a property of the arithmetic rather than a
 * policy: `up` is one word and `up: <service>` is two, so the prefix is a fixed
 * distance from the end. `logs -f` is two words for one subcommand and `ps` is
 * one, so no other row can be measured this way — which is why every caller
 * looks up an `up` row of the file it cares about instead of using the row in
 * front of it.
 */
function composePrefix(script: ScriptEntry): string[] | undefined {
  const argv = script.argv;
  const service = composeService(script);
  const at = argv ? argv.length - (service ? 2 : 1) : -1;
  return argv && at > 0 && argv[at] === 'up' ? argv.slice(0, at) : undefined;
}

/**
 * The command that stops what an `up` row started, built from that row's own
 * argv so it names the same files.
 *
 * `stop` and not `down`: the button is a stop, and `down` would also delete the
 * containers and their networks, which is a different thing than the one the
 * square promises.
 */
function composeStopArgv(script: ScriptEntry): string[] | undefined {
  const prefix = composePrefix(script);
  const service = composeService(script);
  return prefix ? [...prefix, 'stop', ...(service ? [service] : [])] : undefined;
}

/**
 * Asks Docker about every compose file in the scan and repaints.
 *
 * A file that cannot be asked about keeps whatever it last said rather than
 * being marked stopped: "the daemon is down" is not "your stack is down", and
 * the second is a thing a row must not claim on the strength of a failed call.
 */
async function checkContainers(announce: boolean): Promise<void> {
  const scripts = await collectScripts();
  // One probe per compose file, not per row: all the `up` rows of a file share a
  // prefix and would ask the same question.
  const files = new Map<string, ScriptEntry>();
  for (const script of scripts) {
    if (isComposeUp(script) && !files.has(script.manifest.toString())) {
      files.set(script.manifest.toString(), script);
    }
  }

  if (files.size === 0) {
    if (announce) {
      void vscode.window.showInformationMessage('No compose files in this workspace to check.');
    }
    return;
  }

  // A question about a monorepo is still one question: the files are asked in
  // small batches rather than all at once, so a repository of per-service
  // compose files does not put dozens of docker CLI processes up together.
  const BATCH = 4;
  let asked = 0;
  // An entry for a compose file the scan no longer has cannot describe anything
  // on screen, and would still count towards the total below — a deleted file's
  // old services reported as up.
  for (const key of [...containers.keys()]) {
    if (!files.has(key)) {
      containers.delete(key);
    }
  }
  const queue = [...files];
  while (queue.length > 0) {
    await Promise.all(
      queue.splice(0, BATCH).map(async ([key, script]) => {
        const prefix = composePrefix(script);
        // Written per file, and only if nothing else answered meanwhile: a `down`
        // that ends during a long probe writes through `refreshContainers`, and
        // this probe's older picture must not paint the stack back up.
        const before = containers.get(key);
        const state = prefix ? await composeState(prefix, script.cwd.fsPath) : undefined;
        if (!state) {
          // Docker could not answer for this one, so its last answer stands —
          // "I could not ask" is not "your stack is down".
          return;
        }
        asked++;
        if (containers.get(key) === before) {
          containers.set(key, state.running);
        }
      }),
    );
  }

  repaint();
  if (!announce) {
    return;
  }
  if (asked === 0) {
    void vscode.window.showWarningMessage(
      'Could not ask Docker about any compose file. Is Docker running, and is ' +
        '"taskRunnerUltimate.dockerCompose" the command this machine has?',
    );
    return;
  }
  const up = [...containers.values()].reduce((count, services) => count + services.size, 0);
  vscode.window.setStatusBarMessage(
    up > 0
      ? `Task & Script Explorer: ${up} ${up === 1 ? 'service' : 'services'} up`
      : 'Task & Script Explorer: nothing running',
    3000,
  );
}

/**
 * Asks again about the compose file a finished task belongs to, if it was one.
 *
 * Keyed on the manifest the task names rather than on the row it came from, and
 * that is the whole point: `down` changes what is running as surely as `up`
 * does, and so does the `stop` the ■ button builds — which is not a row of the
 * scan at all. Reading the row back and asking it for a probe prefix left both
 * of those unrefreshed, so the feature could not clear the mark its own button
 * had just made wrong.
 *
 * Deliberately not a general "something ended, re-probe everything": that would
 * turn every npm script in the workspace into a Docker call. And nothing for a
 * file nobody has asked about — an absent entry means the question has not been
 * put, and answering it unprompted is the background poll this avoids.
 */
async function recheckAfter(task: vscode.Task): Promise<void> {
  const definition = task.definition as { type?: string; manifest?: string };
  const manifest = definition.type === TASK_TYPE ? definition.manifest : undefined;
  if (manifest && containers.has(manifest)) {
    await refreshContainers(manifest);
  }
}

/**
 * Asks again about one compose file, after something of ours touched it.
 *
 * The probe's words come from one of the file's own `up` rows, wherever the
 * question came from: those are the rows whose argv ends in a subcommand of
 * known length, so they are the only ones a prefix can be read back off.
 */
async function refreshContainers(manifest: string): Promise<void> {
  const script = (await collectScripts()).find(
    (entry) => entry.manifest.toString() === manifest && isComposeUp(entry),
  );
  const prefix = script ? composePrefix(script) : undefined;
  if (!script || !prefix) {
    return;
  }
  const state = await composeState(prefix, script.cwd.fsPath);
  if (state) {
    containers.set(manifest, state.running);
    repaint();
  }
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
function iconFor(script: ScriptEntry, isRunning: boolean, tint?: string, up = false): vscode.ThemeIcon {
  if (isRunning) {
    return runningIcon();
  }
  const category = categoryFor(script);
  // An icon the user picked wins over the category's for the same reason the
  // colour does: the category guessed, this one was asked for by name. The
  // spinner still wins over both — a running row is answering a different
  // question.
  //
  // The shell glyph sits under the category rather than over it: `deploy.sh` is
  // a deployment before it is a shell script, and the rules that read the name
  // say the more useful of the two things. What it replaces is the `play`
  // triangle every unmatched row used to wear — see `SHELL_ICONS`.
  const glyph = storedIcon(scriptRef(script)) ?? category?.icon ?? shellIcon(script) ?? 'play';
  const colored = vscode.workspace.getConfiguration('taskRunnerUltimate').get<boolean>('colorIcons', true);
  // Containers of this row's are up, but nothing of ours is running: the row
  // keeps its own glyph and takes the running colour, which says "this is alive"
  // without the spinner claiming a process of ours to stop. A colour the user
  // painted still wins, as it does over a category.
  //
  // And `colorIcons` still has the last word, for the reason `runningIcon` gives
  // for the spinner it stands in for: the setting promises every icon in the
  // default foreground, and a row that opted out of colour did not opt out of it
  // only while idle.
  if (up && !tint) {
    return new vscode.ThemeIcon(glyph, colored ? new vscode.ThemeColor(RUNNING_COLOR) : undefined);
  }
  const color = tint ?? (category && colored ? category.color : undefined);
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
    // Neither a compose file, a Dockerfile nor a script folder is ever competing
    // with a manifest over what to call the folder: a shell group *is* a folder,
    // and a compose or Dockerfile heading is always named by its own file (see
    // `buildTreeRoots`). Counting them would have a single `docker-compose.yml`
    // beside a `package.json` report the folder as crowded and rename the
    // project's heading after its file — which is what that rule exists to
    // avoid, not cause.
    if (attachable(script.kind)) {
      continue;
    }
    const folder = manifestFolder(script);
    const seen = manifests.get(folder) ?? new Set<string>();
    seen.add(script.manifest.toString());
    manifests.set(folder, seen);
  }
  return new Set([...manifests].filter(([, seen]) => seen.size > 1).map(([folder]) => folder));
}

/**
 * What a heading leads with, and where it lives, as one key — the two halves a
 * second heading has to match for the rows to be indistinguishable.
 */
function headingKey(script: ScriptEntry, shared: boolean): string {
  return `${manifestFolder(script)}::${packageHeading(script, shared)}`;
}

/**
 * The headings that another manifest in the same folder would draw identically.
 *
 * Two manifests in one folder are ordinary — a Cargo.toml beside a Makefile —
 * and they usually say different things: one leads with a package name, the
 * other with a file name. What is not ordinary, and is exactly what the bundler
 * toolchains produce, is both leading with the *same* name. Only those rows pay
 * the longer bullet; see `buildTreeRoots`.
 */
function collidingHeadings(scripts: ScriptEntry[], crowded: ReadonlySet<string>): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const script of scripts) {
    // A compose file, a Dockerfile and a script folder are left out for the same
    // reason `crowdedFolders` leaves them out: none is competing with a manifest
    // over what to call the folder. Those headings are their own file name, and
    // no folder holds that name twice; a script folder is drawn as `shell`
    // whatever its own path says. Counted here, a `scripts/` in a project root
    // would collide with the unnamed package.json above it and put a path on a
    // heading nothing else is competing with.
    if (attachable(script.kind)) {
      continue;
    }
    const shared = crowded.has(manifestFolder(script));
    const key = headingKey(script, shared);
    const manifests = seen.get(key) ?? new Set<string>();
    manifests.add(script.manifest.toString());
    seen.set(key, manifests);
  }
  return new Set([...seen].filter(([, manifests]) => manifests.size > 1).map(([key]) => key));
}

/**
 * Absolute path of the folder a row's file sits in.
 *
 * For a shell row that is the group's own directory rather than the one above
 * it: the group *is* a folder — see `collectShellScripts` — and reading its
 * parent would have `scripts/` share a folder with every manifest in the
 * repository root and report all of them as crowded.
 */
function manifestFolder(script: ScriptEntry): string {
  return path.posix.dirname((script.file ?? script.manifest).path);
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
  // Except for compose, which is named by its file whatever it calls itself. A
  // project root holding `docker-compose.yml` and `docker-compose.dev.yml` very
  // often has the same `name:` in both, and inside a project heading there is no
  // path left to tell two rows apart — so the `name:` would leave the two of
  // them identical. It survives in the tooltip, which is built from `label`.
  if (script.packageName && script.kind !== 'docker-compose') {
    return script.packageName;
  }
  // A shell group's "manifest" is the folder itself, so the name it goes by is
  // that folder and not the one above it — `location` is the group's own path
  // where `directory` is its parent, which for `tools/ci` is the difference
  // between reading `ci` and reading `tools`.
  const folder = path.posix.basename(script.file ? script.location : script.directory);
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
  // A compose file is its file name everywhere, not only on the tree row: this
  // is what the dropdown's separator and the rename dialog's prompt read, and
  // two of a project's compose files very often share one `name:`.
  return script.kind === 'docker-compose' || !script.packageName
    ? path.posix.basename(script.manifest.path)
    : script.packageName;
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

/**
 * The run behind a row, as the task system has it now — not as the row was drawn.
 *
 * A row, a picker entry or an open confirmation can outlive the run it stands
 * for, and a row left over that way is a spinner and a ■ over something that
 * ended. Nothing else is going to clear it: the map is kept by events, and the
 * event that would have cleared it is the one that never arrived. So the miss is
 * repainted here rather than returned in silence, which is what left the ■ inert
 * for as long as the row stayed up.
 */
function executionOf(node: TreeNode | undefined): vscode.TaskExecution | undefined {
  const dropped = pruneRunning();
  const execution =
    node?.kind === 'script'
      ? running.get(node.script.key)
      : node?.kind === 'foreign'
        ? liveExecution(node.execution)
        : undefined;
  // A foreign row is drawn from the listing rather than from the map, so its
  // own miss is the only sign that it too is now stale.
  if (dropped || (!execution && node?.kind === 'foreign')) {
    onStateChanged();
  }
  return execution;
}

async function runNode(node: TreeNode | undefined, reveal: boolean): Promise<void> {
  if (node?.kind === 'script' && (await confirmScript(node.script, 'run'))) {
    await startScript(node.script, reveal);
  }
}

async function stopNode(node: TreeNode | undefined): Promise<void> {
  const execution = executionOf(node);
  if (!execution) {
    // Nothing of ours is running, but Docker said this row's containers are —
    // somebody brought the stack up outside this window. The square still means
    // stop, so it runs the compose command that does it.
    if (node?.kind === 'script' && containersUp(node.script)) {
      await stopContainers(node.script);
    }
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
    if (!(await stopExecution(node.execution))) {
      return;
    }
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
  // A restart that could not stop what is running is not a restart: starting on
  // top of a task that never let go is how two dev servers end up fighting over
  // one port. `stopExecution` has already said so on screen.
  const execution = executionOf(node);
  if (execution && !(await stopExecution(execution))) {
    return;
  }
  await startScript(node.script, reveal);
}

/**
 * Takes down containers this window did not start, by running compose's own
 * `stop` for them and asking again once it has finished.
 *
 * A task like any other, so it gets a terminal, a row in the task list and the
 * same stop button everything else has while it runs — which matters, because
 * stopping a large stack is not instant and a button that looked like it did
 * nothing would be pressed again.
 */
async function stopContainers(script: ScriptEntry): Promise<void> {
  const argv = composeStopArgv(script);
  if (!argv) {
    return;
  }
  if (!(await confirmScript(script, 'stop'))) {
    return;
  }
  const service = composeService(script);
  // The row keeps its own name and key, so the task system, `running` and the
  // tree all agree this work belongs to the row the square was pressed on: it
  // spins while its stop runs, and stops spinning when the stop ends. Only the
  // terminal's title says what is actually being run.
  await vscode.tasks.executeTask(
    buildTask({ ...script, command: argv.join(' '), argv }, true, service ? `stop: ${service}` : 'stop'),
  );
}

/**
 * Stops everything the task system currently runs, ours and foreign alike, and
 * reports whether every one of them went.
 */
async function stopAllTasks(): Promise<boolean> {
  // What the task system still lists is not always what it still runs, so the
  // ones it has already ended are left out: terminating a finished execution is
  // a wait on an end that has already happened, and fifteen seconds of it before
  // Stop All can report anything.
  const results = await Promise.all(liveExecutions().map((execution) => stopExecution(execution)));
  return results.every(Boolean);
}

/** Restarts every running task. Unlike Refresh, this touches processes, not the script list. */
async function restartAllTasks(): Promise<void> {
  // Snapshot the tasks first: the executions are gone once they are terminated.
  // Only the live ones — a task that has already ended is not restarted here,
  // since starting it would be this command raising something nobody was running.
  const tasks = liveExecutions().map((execution) => execution.task);
  // One task that would not stop is enough to call the whole thing off. Starting
  // the rest back up would leave the workspace half restarted and one task
  // running twice, which is harder to see and harder to undo than not having
  // restarted at all.
  if (!(await stopAllTasks())) {
    return;
  }
  for (const task of tasks) {
    await vscode.tasks.executeTask(task);
  }
}

/** A group's rows that are alive right now, in the order the tree shows them. */
function runningScriptsOf(node: TreeNode | undefined): ScriptEntry[] {
  if (node?.kind !== 'group') {
    return [];
  }
  return node.children.flatMap((child) => {
    // An ecosystem parent and the hidden pile hold groups rather than rows, so
    // "everything running under this row" has to go the whole way down.
    if (child.kind === 'group') {
      return runningScriptsOf(child);
    }
    return child.kind === 'script' && running.has(child.script.key) ? [child.script] : [];
  });
}

/**
 * The bare `up` action of a compose item — the whole file, no service named.
 *
 * It is what ▶ runs, and the action Docker's answer is read off. Nothing else
 * is: a heading of a manifest has no single row that stands for the file, and a
 * compose file has exactly one — which is why ▶ and ■ are on the compose rows
 * and nowhere else. `parseCompose` puts `up` and `down` there whatever
 * `dockerComposeCommands` says, so this only comes back empty for a node that
 * is not a compose file at all.
 */
function composeUpNode(node: TreeNode | undefined): (TreeNode & { kind: 'script' }) | undefined {
  if (node?.kind !== 'group' || node.source !== 'docker-compose') {
    return undefined;
  }
  return node.children.find(
    (child): child is TreeNode & { kind: 'script' } =>
      child.kind === 'script' && child.script.name === 'up',
  );
}

/** ▶ on a compose item: the file's own bare `up`, confirmation included. */
async function runGroup(node: TreeNode | undefined): Promise<void> {
  await runLead(composeUpNode(node));
}

/**
 * ▶ on a row that stands for a file: its one bare action, whatever that file's
 * bare action is — `up` for compose, `build` for a Dockerfile.
 *
 * A run already up is not started a second time. The `when` clause on the button
 * says the same thing — ▶ is not drawn on a row with something running under
 * it — but a context value is what the tree was last told, and a second start
 * over the first would overwrite the handle in `running` with the newer one: the
 * first task would then be a terminal nothing in here can stop, ■ and Stop All
 * included. So the map itself has the last word, and the answer to a press that
 * finds it already running is its terminal rather than another process.
 */
async function runLead(lead: (TreeNode & { kind: 'script' }) | undefined): Promise<void> {
  if (!lead) {
    return;
  }
  if (running.has(lead.script.key)) {
    await showTerminal(lead);
    return;
  }
  await runNode(lead, false);
}

/**
 * The bare `build` of a Dockerfile — no `--target`, the whole file.
 *
 * It is the action every Dockerfile has: `parseDockerfile` puts it there whatever
 * `dockerfileCommands` says, which is why ▶ on the row can be relied on to have
 * something to press. The stage builds are `build: <stage>` and are behind the
 * menu with the rest.
 */
function dockerfileBuildNode(node: TreeNode | undefined): (TreeNode & { kind: 'script' }) | undefined {
  if (node?.kind !== 'group' || node.source !== 'dockerfile') {
    return undefined;
  }
  return node.children.find(
    (child): child is TreeNode & { kind: 'script' } =>
      child.kind === 'script' && child.script.name === 'build',
  );
}

/** ▶ on a Dockerfile row: build the image the file describes. */
async function buildImage(node: TreeNode | undefined): Promise<void> {
  await runLead(dockerfileBuildNode(node));
}

/**
 * Everything a Dockerfile offers past the bare `build` — one `build: <stage>` per
 * named stage, and whatever `dockerfileCommands` adds: `run`, `push` and the
 * rest. The same menu compose keeps behind ☰, for the same reason: the row is one
 * line, and these are the variations on the action the row already runs.
 */
async function dockerfileActions(node: TreeNode | undefined): Promise<void> {
  if (node?.kind !== 'group' || node.source !== 'dockerfile') {
    return;
  }
  const actions = node.children.filter(
    (child): child is TreeNode & { kind: 'script' } =>
      child.kind === 'script' && child.script.name !== 'build',
  );
  if (actions.length === 0) {
    void vscode.window.showInformationMessage('No additional Docker commands are configured.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({
      label: action.script.name.startsWith('build: ')
        ? `$(play) Build ${action.script.name.slice(7)}`
        : action.script.name,
      description: action.script.command,
      action,
    })),
    { placeHolder: `Docker command for ${node.label}` },
  );
  if (picked) {
    await runNode(picked.action, true);
  }
}

/**
 * ■ on a compose item: end whatever of ours is attached to the file, then take
 * the stack down.
 *
 * Both halves matter. `up` is an attached task, so a `down` on its own would
 * leave its terminal behind with the containers already gone; and a `down` is
 * the only thing that removes containers somebody brought up outside this
 * window, which no `terminate()` can reach.
 *
 * `down` runs only once every stop has actually taken — `stopExecution` returns
 * `false` on a task that outlived the wait, and has said so on screen — because
 * a `down` racing a live `up` is the stack being removed and raised again by
 * turns.
 *
 * Nothing here asks first. Pressing ■ on a file that *is* a stack is already
 * the deliberate gesture, and a compose row carries no confirmation flag for the
 * same reason it carries no toggle to clear one with — see `needsConfirmation`.
 */
async function stopStack(node: TreeNode | undefined): Promise<void> {
  if (node?.kind !== 'group' || node.source !== 'docker-compose') {
    return;
  }
  const down = node.children.find(
    (child): child is TreeNode & { kind: 'script' } =>
      child.kind === 'script' && child.script.name === 'down',
  );
  if (!down) {
    return;
  }
  const stopped = await Promise.all(
    runningScriptsOf(node).map((script) => {
      const execution = running.get(script.key);
      return execution ? stopExecution(execution) : Promise.resolve(true);
    }),
  );
  if (!stopped.every(Boolean)) {
    return;
  }
  await startScript(down.script, false);
}

/** Extra compose commands, including one `up` action for every declared service. */
async function composeActions(node: TreeNode | undefined): Promise<void> {
  if (node?.kind !== 'group' || node.source !== 'docker-compose') {
    return;
  }
  const actions = node.children.filter(
    (child): child is TreeNode & { kind: 'script' } =>
      child.kind === 'script' && child.script.name !== 'up' && child.script.name !== 'down',
  );
  if (actions.length === 0) {
    void vscode.window.showInformationMessage('No additional Compose actions are configured.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({
      label: action.script.name.startsWith('up: ')
        ? `$(play) Up ${action.script.name.slice(4)}`
        : action.script.name,
      description: action.script.command,
      action,
    })),
    { placeHolder: `Compose command for ${node.label}` },
  );
  if (picked) {
    await runNode(picked.action, true);
  }
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
    // Only this row is skipped when it will not stop; the rest of the group has
    // nothing to do with it and is restarted as asked.
    if (execution && !(await stopExecution(execution))) {
      continue;
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
 * The terminal of a row, or the message saying why there is none.
 * Shared by the two ways of going to the output — the panel and the editor tab.
 */
function terminalOf(node: TreeNode | undefined): vscode.Terminal | undefined {
  const task = taskOf(node);
  if (!task) {
    return undefined;
  }

  const terminal = terminalFor(task);
  if (!terminal) {
    // Either the terminal has been closed — killing a task terminal ends the
    // task, so this is the window between the two — or the task's owner runs it
    // without one. Said out loud either way: a command that is offered and then
    // does nothing at all is the worse of the two answers.
    void vscode.window.showInformationMessage(`${task.name} has no open terminal.`);
  }
  return terminal;
}

/**
 * The task a row stands for, running or not.
 *
 * The terminal outlives the run: a dedicated task panel stays open with the
 * output still in it after the process is gone, which is exactly when the log is
 * wanted — a task that has just failed is read after it ended, not during. So
 * going to the output is answered from the task itself, which is all the name
 * matching in `terminalFor` ever needed, and the live handle is preferred only
 * because it carries the task the system is really running.
 */
function taskOf(node: TreeNode | undefined): vscode.Task | undefined {
  const execution = executionOf(node);
  if (execution) {
    return execution.task;
  }
  if (node?.kind === 'foreign') {
    return node.execution.task;
  }
  // Built rather than remembered: ours is a pure function of the script, and the
  // name it gives the terminal is the same one the ended run was drawn with.
  return node?.kind === 'script' ? buildTask(node.script) : undefined;
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
 * A new terminal with the row's command line typed into it and *not* run.
 *
 * The one thing ▶ cannot do: a script that takes arguments — a `deploy.sh` that
 * wants an environment, a `setup.ps1` that wants a flag — has nowhere to say
 * them, since the tree runs what the file is and nothing more. Rather than
 * invent a prompt for arguments and a place to remember them, this hands over
 * the same command the row would have run, in a real terminal, with the cursor
 * sitting at the end of it: type the rest and press Enter, or edit the line, or
 * throw it away.
 *
 * `sendText(…, false)` is what leaves it unrun — the text goes to the terminal's
 * input as if it had been typed. The terminal is a new one every time, and not
 * one being reused: the line is going to be edited, and a terminal already
 * running something has no free prompt to edit it at.
 *
 * The cwd is the task's own, so the relative path in the line is the path the
 * shell resolves — the workspace folder root for a shell row, which is where
 * `./scripts/deploy.sh` means what it says.
 */
async function addToTerminal(node: TreeNode | undefined): Promise<void> {
  if (node?.kind !== 'script') {
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: displayName(node.script),
    cwd: node.script.cwd,
  });
  terminal.show();
  terminal.sendText(terminalLine(node.script), false);
}

/**
 * The row's command line as a *shell* should receive it, every argument literal.
 *
 * Deliberately not `commandFor`, which is the line the tooltip and the picker
 * show and is quoted for the eye alone: it wraps anything unusual in double
 * quotes, and a double-quoted string is where every shell that matters still
 * performs substitution. A script checked out as `$(id).sh` would then be typed
 * as `bash "./scripts/$(id).sh"`, and the Enter the user presses would run `id`
 * and then a path that is not the row they clicked. Nothing here is executed for
 * them, which is the point of the feature — and it is exactly why the line has
 * to be one they can press Enter on safely.
 *
 * Plain arguments — word characters and the punctuation paths and task names are
 * built from — are left bare, which is nearly every line this ever produces:
 * `bash ./scripts/deploy.sh` reads as itself, and quoting it would only be noise
 * in a line written to be edited by hand.
 */
function terminalLine(script: ScriptEntry): string {
  const quoting = terminalQuoting();
  const argv = launchArgv(script);
  const line = argv.map((value) => (plainArgument(value) ? value : quoteFor(quoting, value))).join(' ');
  // PowerShell reads a quoted string at the start of a line as a value, not as
  // something to run: `'./scripts/build all.bat'` prints the path and stops. The
  // call operator is what turns it back into a command, and it is needed exactly
  // when the first word had to be quoted — a `.bat` or `.cmd` row, whose runner
  // is empty by design, is the path itself and so the word in question.
  return quoting === 'powershell' && argv[0] !== undefined && !plainArgument(argv[0])
    ? `& ${line}`
    : line;
}

/**
 * Which family of shell the new terminal opens in, as far as the workbench will
 * say: `env.shell` is the path of the profile it starts, and its file name is
 * the only thing in it that names a shell.
 *
 * Git Bash on Windows is why the name is read before the platform: it is a POSIX
 * shell on a machine whose default is not, and quoting it as PowerShell would
 * leave `$(…)` live. When there is no name to read, the platform decides, which
 * is the workbench's own default either way.
 */
function terminalQuoting(): 'posix' | 'powershell' | 'cmd' {
  const name = (vscode.env.shell ?? '')
    .toLowerCase()
    .split(/[\\/]/)
    .pop();
  if (name) {
    if (name.startsWith('pwsh') || name.startsWith('powershell')) {
      return 'powershell';
    }
    return name.startsWith('cmd') ? 'cmd' : 'posix';
  }
  return process.platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * One argument, quoted so the shell reads it as text and nothing else.
 *
 * Single quotes in both shells that substitute: they are the only quoting in
 * `sh` and in PowerShell that leaves `$`, backticks and `$(…)` inert, and each
 * has its own way of writing a quote inside one — `'\''` for the first, doubled
 * for the second.
 *
 * `cmd.exe` has no substitution to protect against, so double quotes are enough
 * there. `%VAR%` still expands inside them and cannot be escaped in a line typed
 * at a prompt, which is a name that reads oddly rather than a name that runs:
 * cmd expands it to a value, never to a command.
 */
function quoteFor(quoting: 'posix' | 'powershell' | 'cmd', value: string): string {
  if (quoting === 'cmd') {
    return `"${value.replace(/"/g, '""')}"`;
  }
  const escaped = quoting === 'powershell' ? value.replace(/'/g, "''") : value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
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
  // Warmed before the first row is built, never while one is: `scriptItem` runs
  // on every render — a start, a stop, a keystroke — and the pack is a file on
  // disk. Read once here and answered out of memory from then on.
  await iconPack();

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
  // Held by identity, because showing this picker hides any earlier one and the
  // hide handler of that one runs after this line. Without the check below it
  // would clear the picker on screen instead of itself, taking Shift+Enter and
  // the live refresh with it.
  const handle: ActivePicker = { refresh: render, reload, activeItem: () => picker.activeItems[0] };
  activePicker = handle;
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
    if (item.script && !executionOf(nodeOf(item))) {
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
    if (activePicker === handle) {
      activePicker = undefined;
      void vscode.commands.executeCommand('setContext', CONTEXT_PICKER_OPEN, false);
    }
    picker.dispose();
  });

  picker.show();
}

const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });

/**
 * The tree's shape, flattened into separators and rows: the starred tasks, then
 * the tasks that came from outside a manifest, then one block per package, in the
 * order the tree has them and with the same order inside each. Two surfaces
 * showing the same list in two different orders is two things to learn instead of
 * one.
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

  // One block per package, keeping the order the scan produced — which in
  // `ecosystem` mode is already gathered into one run per ecosystem, since
  // `savedOrder` did the gathering. That is what keeps this list and the tree in
  // the same order without either of them knowing about the other.
  const blocks = new Map<string, { label: string; ecosystem: Ecosystem; items: Item[] }>();
  for (const script of scripts) {
    if (starred.has(script.key)) {
      continue;
    }
    const key = script.manifest.toString();
    let block = blocks.get(key);
    if (!block) {
      block = { label: packageLabel(script), ecosystem: ecosystemOf(script.kind), items: [] };
      blocks.set(key, block);
    }
    block.items.push(scriptItem(script, false));
  }

  // A separator is the only thing that closes the block above it off, so package
  // headings appear as soon as there is anything above them — including in a
  // single-package workspace, where on their own they would be pure noise.
  const headings = multiPackage || items.length > 0;

  const nested = hierarchical();
  let previous: Ecosystem | undefined;
  for (const block of blocks.values()) {
    if (headings) {
      // The ecosystem names the head of its run and nothing after it. Repeating
      // it on every separator would be the same noise the tree avoids by not
      // printing the workspace name down the whole column of headings.
      const opens = nested && block.ecosystem !== previous;
      items.push(separator(opens ? `${ECOSYSTEMS[block.ecosystem].label} · ${block.label}` : block.label));
    }
    previous = block.ecosystem;
    items.push(...block.items);
  }

  return items;
}

/**
 * One script row. Under Favorites it also says which package it came from, the
 * same way the tree's starred rows do — listed away from a package heading, the
 * row has to answer that itself.
 *
 * A codicon is written into the label as `$(id)` rather than passed as
 * `iconPath`, which looks like the worse of the two and is not:
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
 * So for a codicon `iconPath` costs the spinner and buys nothing. In the label it
 * is an inline span sized to the glyph, and it spins true.
 *
 * An icon out of the file icon theme is the one exception, and it is the same
 * sentence read the other way: it is a picture, not a glyph in the font, so the
 * label cannot carry it and `iconPath` is the only way in. Such a row never
 * spins — the spinner wins over a picked icon — so the cost above is not one it
 * can pay, and being a URI icon it is the one kind drawn in colour here.
 */
function scriptItem(script: ScriptEntry, inFavorites: boolean): Item {
  const isRunning = running.has(script.key);
  // The user's icon carries over from the tree: the picker and the tree are two
  // views of the same rows, and a row you marked should be findable in both.
  const icon = isRunning ? 'loading~spin' : storedIcon(scriptRef(script)) ?? categoryFor(script)?.icon ?? 'play';
  // An icon out of the file icon theme carries over too, and here it has to be
  // the picture itself: a quick pick row has no resource behind it for the
  // workbench to resolve a `ThemeIcon.File` against, the way a tree row does. A
  // pack that draws from a font has no picture to give, and such a row keeps the
  // glyph below — findable in both lists either way, which is the point.
  const specimen = isRunning ? undefined : storedSpecimen(scriptRef(script));
  const art = specimen ? packArt(specimen.kind, specimen.name) : undefined;
  return {
    label: art ? displayName(script) : `$(${icon}) ${displayName(script)}`,
    iconPath: art,
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

/**
 * Drops an ended execution from the running map, and only the execution — the
 * same script started twice shares one key there, once through our task and once
 * through the built-in npm provider, and one of the two ending says nothing
 * about the other. What is left alive takes over the key, so the row keeps
 * spinning and the count keeps counting while a copy of it is still up.
 *
 * The ending is noted rather than the listing trusted to have caught up with it:
 * the two orders differ between the event and the poll in `waitForEnd`, and
 * neither is ours to depend on. `pruneRunning` then reads the listing with that
 * note applied, so what takes over the key is something else that is genuinely
 * running and not the run that has just finished.
 */
function forgetExecution(execution: vscode.TaskExecution): void {
  markEnded(execution);
  pruneRunning();
}

/**
 * Stops a task and says whether it actually stopped.
 *
 * A `false` is the deadline in `waitForEnd` running out with the task still
 * listed. The row stays as it is when that happens — dropping it from `running`
 * would draw a stopped task over a live process, and a restart on top of that
 * would raise a second copy beside the first, which is the failure the wait was
 * there to prevent in the first place.
 */
async function stopExecution(execution: vscode.TaskExecution): Promise<boolean> {
  // A row or confirmation dialog can outlive its execution, especially after
  // reloading the extension host. Terminating that stale handle can open VS
  // Code's task picker. Use the current handle, or treat an absent run as stopped.
  const live = liveExecution(execution);
  if (!live) {
    forgetExecution(execution);
    onStateChanged();
    return true;
  }
  execution = live;
  const ended = waitForEnd(execution);
  // `terminate()` rejects when the task has already gone between the listing
  // above and this call — a short script, or a Ctrl+C in its terminal. The wait
  // below sees that ending; the rejection itself has nothing to add.
  Promise.resolve(execution.terminate()).catch(() => undefined);
  const stopped = await ended;

  if (!stopped) {
    void vscode.window.showWarningMessage(
      `"${execution.task.name}" did not stop. It is still running — its terminal has the last word on why.`,
    );
    onStateChanged();
    return false;
  }

  forgetExecution(execution);
  onStateChanged();
  return true;
}

/**
 * Resolves `true` when the execution ends. The event is the real signal; the poll
 * covers the cases where it never arrives, and — unlike a flat grace period —
 * it keeps waiting while the execution is still listed, so a process that takes
 * its time dying after `terminate()` is not declared gone while it still holds
 * its port, which is what would let a restart raise a second copy beside it.
 *
 * The deadline is the way out when the task system itself never lets go, and it
 * resolves `false`: a wait that gave up has learnt nothing about the process, and
 * reporting that as an ending is how a live task gets drawn as a stopped one.
 */
function waitForEnd(execution: vscode.TaskExecution): Promise<boolean> {
  // While the handle is the one the task system lists, identity is the answer:
  // with two runs of one task up (`instanceLimit`, a watch started twice), the
  // end of the other run must not read as the end of this one. `sameExecution`
  // is the fallback for a handle the listing has already replaced.
  const listed = vscode.tasks.taskExecutions.includes(execution);
  const matches = (item: vscode.TaskExecution) =>
    listed ? item === execution : sameExecution(item, execution);
  const alive = () => vscode.tasks.taskExecutions.some(matches);

  return new Promise((resolve) => {
    const deadline = Date.now() + 15_000;
    const finish = (ended: boolean) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(ended);
    };
    const poll = () => {
      if (!alive()) {
        finish(true);
      } else if (Date.now() >= deadline) {
        finish(false);
      } else {
        timer = setTimeout(poll, 500);
      }
    };
    let timer = setTimeout(poll, 500);

    const subscription = vscode.tasks.onDidEndTask((event) => {
      if (matches(event.execution)) {
        finish(true);
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

function buildTask(script: ScriptEntry, reveal = true, verb?: string): vscode.Task {
  const folder = vscode.workspace.getWorkspaceFolder(script.manifest);
  // A directory can hold a package.json, a Makefile and a justfile, each with a
  // `test`, so what disambiguates the terminal's name is the manifest and not
  // just the directory — except for a Node package, where the file name is
  // always package.json and would only be noise.
  const where = script.kind === 'npm' || script.kind === 'deno' ? script.directory : script.location;
  const argv = launchArgv(script);
  // The definition names the row and the title names the work, which are the
  // same word for every task but one: the ■ on a row whose containers somebody
  // else brought up runs `stop` *for that row*, and filing it under a `stop`
  // nothing declares gave the task system a key no row carried — counted on the
  // badge, shown nowhere, and dropped again by `pruneRunning` the moment it
  // looked for the row that key named.
  const shown = verb ?? script.name;
  const task = new vscode.Task(
    { type: TASK_TYPE, script: script.name, manifest: script.manifest.toString() },
    folder ?? vscode.TaskScope.Workspace,
    where ? `${shown} (${where})` : shown,
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
    // The program goes through the same quoting as everything after it. For
    // every runner this is a bare word and nothing happens; for a shell row with
    // `shellRunner` emptied the program *is* a path off disk, and a space in it
    // — or worse — would otherwise reach the shell unquoted.
    return new vscode.ShellExecution(shellArgument(argv[0]), argv.slice(1).map(shellArgument), { cwd });
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
/** Whether `context.subscriptions` already holds the one entry that disposes them. */
let statusBarRegistered = false;

function disposeStatusBar(): void {
  statusBarItem?.dispose();
  statusBarRestartItem?.dispose();
  statusBarStopItem?.dispose();
  statusBarItem = undefined;
  statusBarRestartItem = undefined;
  statusBarStopItem = undefined;
}

function syncStatusBar(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace
    .getConfiguration('taskRunnerUltimate')
    .get<boolean>('showInStatusBar', true);

  if (!enabled) {
    disposeStatusBar();
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

    // One subscription for the life of the extension, not one per rebuild: the
    // items are made again every time `showInStatusBar` is turned back on, and
    // pushing each new trio would grow the list by three dead disposables per
    // toggle. This one disposes whichever trio is current when the window closes.
    if (!statusBarRegistered) {
      statusBarRegistered = true;
      context.subscriptions.push({ dispose: disposeStatusBar });
    }
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
