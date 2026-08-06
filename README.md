# ▶ Handy Tasks Runner

**Every script in the workspace, and every task that is running, in one dropdown at the top of the
window.**

One click on the play icon and the whole workspace is in front of you: the `scripts` of every
`package.json`, the `tasks` of every `deno.json`, grouped per package, searchable by name *or* by the
command behind it. Anything currently running floats to the top of the list, spinner and all — so the
list is not just a launcher, it is where you see what is alive and put a stop to it.

There is no mode switch and nothing to learn: <kbd>Enter</kbd> starts a script, <kbd>Enter</kbd> on a
running one stops it, <kbd>Shift</kbd>+<kbd>Enter</kbd> restarts it. The badge on the toolbar icon
keeps the count of running tasks in your peripheral vision, so a forgotten `dev` server or a watcher
left over from yesterday no longer hides in a stack of terminal tabs.

It does not guess how to run things, either. Whether a package wants `npm run`, `yarn`, `pnpm run`,
`bun run` or `deno task` is read off the project itself — the `packageManager` field, `engines`, or
the lock and config files next to the package and above it — so the same list works unchanged across
a mixed monorepo.

- **All scripts, one list** — every `package.json` (`scripts`) and `deno.json`/`deno.jsonc` (`tasks`)
  in the workspace, grouped per package, `node_modules` and build output skipped.
- **Running tasks included** — even ones this extension did not start: tasks from `tasks.json`, other
  extensions, or the built-in npm list. Stop or restart them from the same place.
- **Toggle on <kbd>Enter</kbd>** — start what is stopped, stop what is running; ⟳ or
  <kbd>Shift</kbd>+<kbd>Enter</kbd> restarts, with a cleared terminal.
- **A live badge** — the number of running tasks, right on the toolbar icon and in the status bar.
- **Knows your runner** — npm, yarn, pnpm, bun and deno, detected per package, overridable.
- **Real tasks, not typed-out terminal commands** — running state, stop and restart are reliable, and
  every script also shows up under **Run Task…**.

## Where the button appears

| Place | Notes |
| --- | --- |
| Editor title bar (top right) | The badged icon. Toggle with `handyTasksRunner.showInEditorTitle`. |
| Activity bar (left strip) | The **Handy Tasks** view: the same list as a tree, with a native count badge. Always visible, whatever the active editor is. |
| Status bar (bottom left) | `$(play-circle) Handy Tasks`, or `$(sync~spin) Handy Tasks N` while tasks run. Toggle with `handyTasksRunner.showInStatusBar`. |
| Command palette | `Handy Tasks Runner: Show Scripts` |
| Keybinding | `Cmd+Alt+R` / `Ctrl+Alt+R` |

> The Command Center itself (the search field in the title bar) is **not** extensible: as of
> VS Code 1.131 the only extension-facing toolbar menus are `editor/title`, `view/title`,
> `scm/title`, `notebook/toolbar` and friends — `commandCenter/center` is internal. So the
> top-of-window button lives in the editor title bar, which is the closest available spot.

### If the title bar icon is missing

The editor title bar is not a guaranteed surface: some editors do not render extension actions
there at all (terminal-in-an-editor, the Settings and Extensions tabs, the Welcome page), and when
a group is narrow or another extension crowds the bar, VS Code folds actions into the `…` overflow
menu. Notebooks are covered separately through `notebook/toolbar`, and the icon is registered at
`navigation@1` so it is among the first to survive the overflow — but the surface that is *always*
there is the activity bar view, plus the status bar entry and `Cmd+Alt+R`.

### The Handy Tasks view

The activity bar icon opens a tree with the same content as the dropdown: a **Running** group on
top, then one group per package. Clicking a row toggles it — run if stopped, stop if running — and
each row has inline ▶ / ⟳ / ■ buttons. The count of running tasks rides on the activity bar icon as
a real VS Code badge. The view title has the dropdown button and a refresh button.

Clicking an activity bar icon can only reveal its view, never run a command, so it cannot literally
do "what the toolbar icon does". If you would rather have the dropdown anyway, set
`handyTasksRunner.openDropdownFromActivityBar` to `true` and it opens as soon as the view is revealed.

## In the dropdown

```
Running (2) ─────────────────────
⟳ dev            vite          ⟳ ■
⟳ tsc: watch     Workspace task ⟳ ■
root-pkg — package.json ─────────
▶ build          tsc -p .        ⟳
▶ test:e2e       playwright test ⟳
```

| Action | Effect |
| --- | --- |
| `Enter` on a stopped script | Starts it and closes the picker, so the task terminal is visible. |
| `Enter` on a running task | Stops it; the picker stays open and refreshes in place. |
| `Shift+Enter` | Restarts the focused entry (starts it if it was stopped). |
| ⟳ button | Same as `Shift+Enter`, without leaving the keyboard row. |
| ■ button | Stops that task. Only shown for entries that are actually running. |

The **Running** group lists *all* running tasks, including ones this extension did not start —
tasks from `tasks.json`, other extensions, or the built-in npm task provider. Tasks that map onto a
package.json script (our own and `npm:` ones) are shown as that script rather than duplicated, so a
script started from the built-in npm list can be stopped from here too.

## Behaviour

- Scans `**/package.json` (the `scripts` field) and `**/deno.json` / `**/deno.jsonc` (the `tasks`
  field), skipping `node_modules`, `dist`, `out`, `build`, `.next`, `coverage` (configurable via
  `handyTasksRunner.exclude`). `deno.jsonc` comments and trailing commas are tolerated, and both the
  string and the Deno 2 object task form (`{ "command": …, "description": … }`) are read.
- In a monorepo the idle list is grouped per package, showing the package name and relative path.
- Scripts run through the VS Code **task** system (not a raw terminal), which is what makes running
  state, stop and restart reliable. Each script gets a dedicated task terminal that is cleared on
  restart. The scripts also show up under **Run Task…** as `scripts: <name>`.
- The script list is cached and invalidated when any manifest changes;
  `Handy Tasks Runner: Refresh Scripts` forces a rescan.

## Runner detection

Checked in this order, per package, first match wins:

1. `handyTasksRunner.packageManager`, if set to something other than `auto`.
2. The `packageManager` field — `"packageManager": "pnpm@9.1.0"`.
3. The `engines` field — `deno`, `bun`, `pnpm`, `yarn`, then `npm` (so the usual
   `{ "node": …, "npm": … }` still resolves to npm).
4. Lock and config files, in the package directory first, then each parent up to the workspace
   folder — which is where a monorepo keeps its lock file.

| Signal | Runner |
| --- | --- |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `pnpm run <script>` |
| `yarn.lock`, `.yarnrc.yml` | `yarn <script>` |
| `bun.lockb`, `bun.lock`, `bunfig.toml` | `bun run <script>` |
| `deno.lock`, `deno.json`, `deno.jsonc` | `deno task <script>` |
| `package-lock.json`, `npm-shrinkwrap.json` | `npm run <script>` |
| nothing found | `npm run <script>` |

Two details worth knowing:

- Deno signals are checked **last** within a directory, so a package.json project that also carries
  a `deno.lock` still runs its scripts with the npm-family runner its own lock file names.
- A task that came from a `deno.json(c)` always runs as `deno task <name>`, including when
  `handyTasksRunner.packageManager` is pinned to something else — no other runner can execute it.

### How the badge works

The activity bar badge is a real API (`TreeView.badge`). The toolbar one is not: editor title icons
are static images with no way to draw on them. So `media/` holds pre-rendered icons for counts 1–9
plus `9+`, one command per variant, and the extension publishes the running count into the
`handyTasksRunner.runningCount` context key — the `editor/title` menu then shows whichever variant
matches. Those icons and the menu entries that reference them are generated:

```bash
npm run gen     # tools/generate-contributions.js
```

It rewrites `media/*.svg`, the 256×256 `media/icon.png` used on the Marketplace (rasterised from the
same glyph, since SVG icons are rejected there) and the `commands`, `menus`, `views` and
`keybindings` sections of `package.json`. Edit the generator, not those files.

## Development

```bash
npm install
npm run watch     # or: npm run compile
```

Then press <kbd>F5</kbd> ("Run Extension") to open a second VS Code window with the extension loaded.

To build and install a package:

```bash
npx @vscode/vsce package --skip-license
code --install-extension handy-tasks-runner-0.0.1.vsix --force
```

Reload the VS Code window after installing (`Developer: Reload Window`).
