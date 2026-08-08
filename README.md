# ▶ Task Runner Manager

**Every script in your workspace, and everything currently running, in one list. Start, stop and
restart without ever going looking for a terminal tab.**

Tasks scatter. A monorepo buries them across a dozen `package.json` files, the Rust service next to
them keeps its own in a `Makefile.toml`, the Python one in `pyproject.toml`, and there is a
`justfile` at the root that half the team forgets exists. The dev server you started an hour ago is
alive in a tab you can no longer find, and running anything by hand means getting the directory
*and* the tool right first. Task Runner Manager collapses all of that into one list, and gives you
three ways to reach it.

![Task Runner Manager in action](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-task-runner-ultimate/main/promo-video.gif)

### ▶ in the toolbar of every file

The play icon sits in the editor title bar, so the whole workspace is one click away from wherever
you happen to be. It wears a **live badge with the number of running tasks** — the watcher you forgot
about stays in the corner of your eye instead of hiding in a stack of terminals.

### A hotkey, from anywhere

<kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>T</kbd> on macOS, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> on
Windows and Linux. Every task of every manifest in the workspace, without touching the mouse — from
the editor, the terminal, anywhere. Both defaults were picked because VS Code leaves them free, and
[changing them](#keyboard-shortcuts) takes one line.

### A panel in the left bar

Always there, whatever the active editor is: every task of every manifest, **grouped by the file it
came from**, each row carrying **its own icon and colour** for what it actually does — ▶ for dev
servers, a beaker for tests, a rocket for releases, a database for migrations. Running tasks spin at
the top of their group, and the count rides on the activity bar icon as a real VS Code badge.

Two buttons appear in the panel header the moment anything is running: **stop everything** and
**restart everything**. Killing five watchers before a rebase, or bringing the whole stack back up
after switching branches, is one click rather than five terminal tabs. Every row also has inline
▶ / ⟳ / ■ buttons of its own.

### And it knows how to run things

Whether a package wants `npm run`, `yarn`, `pnpm run`, `bun run` or `deno task` is read off the
project itself — the `packageManager` field, `engines`, or the lock files beside the package and
above it. Everything else names its own runner by the table it is declared in: a task under
`[tool.pdm.scripts]` is a pdm task wherever it lives. So one list works unchanged across a mixed
monorepo.

- **Every task, one list** — [nine ecosystems](#what-gets-scanned): Node, Rust, Python, Make, just,
  go-task, Go, Composer and mise, grouped per manifest, `node_modules`, `target`, `.venv` and build
  output skipped.
- **Searchable by command, not just by name** — type `vitest` and find the script that runs it.
- **Running tasks included** — even ones this extension did not start: tasks from `tasks.json`, other
  extensions, or the built-in npm list. Stop or restart them from the same place.
- **Toggle on <kbd>Enter</kbd>** — start what is stopped, stop what is running; ⟳ or
  <kbd>Shift</kbd>+<kbd>Enter</kbd> restarts, with a cleared terminal.
- **Stop all / restart all** — for when the whole stack needs to go down or come back.
- **Favorites** — star the two or three tasks you actually run and they pin to a group at the top
  of the tree, above everything, without leaving the manifest they belong to.
- **Rename any row** — `dev` becomes `API server`. Display only: the manifest is never edited, and
  the real name stays visible beside it and searchable.
- **A live badge** — the number of running tasks, on the toolbar icon, the panel and the status bar.
- **Knows your runner** — npm, yarn, pnpm, bun and deno, detected per package, overridable.
- **Real tasks, not typed-out terminal commands** — running state, stop and restart are reliable, and
  every task also shows up under **Run Task…**.

## What gets scanned

| Ecosystem | File | Tasks read from | Runs as |
| --- | --- | --- | --- |
| **Node** | `package.json` | `scripts` | `npm run` / `yarn` / `pnpm run` / `bun run` — [detected](#runner-detection) |
| | `deno.json`, `deno.jsonc` | `tasks` | `deno task <name>` |
| **Rust** | `Cargo.toml` | the crate itself — see [below](#rust) | `cargo run --bin …`, `cargo test`, … |
| | `Makefile.toml` | `[tasks.*]` (cargo-make) | `cargo make <name>` |
| **Python** | `pyproject.toml` | `[tool.poetry.scripts]` | `poetry run <name>` |
| | | `[tool.pdm.scripts]` | `pdm run <name>` |
| | | `[tool.rye.scripts]` | `rye run <name>` |
| | | `[tool.poe.tasks]` | `poe <name>`, through poetry when the project uses it |
| | | `[tool.hatch.envs.<env>.scripts]` | `hatch run <env>:<name>` |
| | | `[project.scripts]` | `<uv\|poetry\|pdm\|rye\|pipenv\|hatch> run <name>` — see [below](#python) |
| | `Pipfile` | `[scripts]` | `pipenv run <name>` |
| | `tox.ini` | `envlist` and `[testenv:*]` | `tox -e <env>` |
| | `noxfile.py` | `@nox.session` functions | `nox -s <session>` |
| **Make** | `Makefile`, `makefile`, `GNUmakefile` | the targets | `make <target>` |
| **just** | `justfile`, `Justfile`, `.justfile` | the recipes | `just <recipe>` |
| **go-task** | `Taskfile.yml` and friends | `tasks:` | `task <name>` |
| **Go** | `go.mod` | the standard subcommands | `go test ./...`, … |
| **PHP** | `composer.json` | `scripts` | `composer run-script <name>` |
| **mise** | `mise.toml`, `.mise.toml` | `[tasks.*]` | `mise run <name>` |

Turn any of them off with `taskRunnerUltimate.sources` — a removed ecosystem's files are never
opened at all, which is also the fastest way to quieten a repository carrying a `Makefile` nobody
runs.

Descriptions are used where a format has them (`desc:` in a Taskfile, `description` in cargo-make
and tox, `help` in a pdm script, `## text` on a Make target, the comment above a `just` recipe), and
the command itself is shown when it does not.

### Rust

A crate declares no scripts, so its rows are derived from what the crate actually *is* rather than
from a fixed list — a library gets no `run` row, because `cargo run` in a library is an error:

| The crate has | You get |
| --- | --- |
| `src/main.rs`, or one `[[bin]]` | `run` |
| several binaries | one row per binary — `cargo run --bin <name>` |
| no binary at all | no `run` row |
| `examples/*.rs` or `[[example]]` | one row per example — `cargo run --example <name>` |
| `[workspace]` and no `[package]` | the plain subcommands only, run at the workspace root |

Alongside that, `taskRunnerUltimate.cargoCommands` lists the subcommands every crate gets — `run`,
`build`, `test`, `clippy` and `fmt` by default. Add `check`, `bench`, `doc`, `clean` or `update`, or
anything else, which runs as `cargo <name>`. Binaries are found the way cargo finds them: `[[bin]]`
entries, `src/main.rs` named after the package, and every `src/bin/*.rs`.

`go.mod` works the same way through `taskRunnerUltimate.goCommands`, and drops `run` for a module
whose root is not itself a program.

### Python

Most Python tasks say which tool runs them by the table they sit in, so nothing has to be guessed.
`[project.scripts]` is the exception — those are console entry points that only exist inside the
project's environment — so the tool that can enter it is detected: the lock file beside
`pyproject.toml` first (`uv.lock`, `poetry.lock`, `pdm.lock`, `requirements.lock`, `Pipfile.lock`),
then whichever `[tool.*]` table the project configures. If neither answers, the entry points are
left out rather than listed with a command that would not work. `taskRunnerUltimate.pythonRunner`
pins it, and `none` hides them entirely.

## Where the button appears

| Place | Notes |
| --- | --- |
| Editor title bar (top right) | The badged icon. Toggle with `taskRunnerUltimate.showInEditorTitle`. |
| Activity bar (left strip) | The **Task Runner Manager** view: the same list as a tree, with a native count badge. Always visible, whatever the active editor is. |
| Status bar (bottom left) | `$(play-circle) Task Runner`, or `$(sync~spin) Task Runner N` while tasks run. Toggle with `taskRunnerUltimate.showInStatusBar`. |
| Command palette | `Task Runner Manager: Show Scripts` |
| Keybinding | `Ctrl+Cmd+T` on macOS, `Ctrl+Alt+T` on Windows and Linux — see [Keyboard shortcuts](#keyboard-shortcuts) |

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
there is the activity bar view, plus the status bar entry and the keyboard shortcut.

### The Task Runner Manager view

The activity bar icon opens a tree with the same content as the dropdown, in this order: **FAVORITES**
first, then **Other tasks** — anything running that this extension did not start — then one group per
manifest. Groups with something running float above the idle ones, and inside a group the running
tasks float to the top, so whatever is alive is always the first thing on screen. Clicking a row
toggles it — run if stopped, stop if running — and hovering one reveals inline ☆ / ▶ / ⟳ / ■ buttons.
The count of running tasks rides on the activity bar icon as a real VS Code badge.

A group is one manifest, not one directory: a Rust service with a `Cargo.toml`, a `Makefile` and a
`justfile` side by side gets three, each headed by its file name and the folder it sits in. A
manifest that names its package — `name` in a `package.json`, `[package] name` in a `Cargo.toml`,
`module` in a `go.mod` — is headed by that name instead.

Every group heading also carries an icon for what it holds. ★ is FAVORITES, ∿ is the tasks this
extension did not start, and everything else says which tool its rows will actually go through — so
a monorepo mixing pnpm workspaces with a Deno service and a cargo crate says so on the headings,
before any row is read:

| Icon | Group |
| --- | --- |
| ★ | FAVORITES |
| ▣ | npm |
| 🗄 | yarn |
| ≣ | pnpm |
| ⚡ | bun |
| 🌐 | deno |
| ⚙ | cargo, cargo-make |
| 🛠 | poetry, pdm, hatch, rye, poe, pipenv |
| 🧪 | tox, nox |
| ▤ | make |
| ☑ | just |
| ≡ | go-task |
| ⌗ | go |
| ⟨⟩ | composer |
| ⧉ | mise |
| ∿ | Other tasks — running, but not from a manifest |

For a Node package the runner shown is the one that will be used, so a
`taskRunnerUltimate.packageManager` override moves the icon with it.

The view header holds four actions. **Restart all** (⟳) and **stop all** (◼) appear only while
something is running, so the header stays quiet on an idle workspace; **open the dropdown** (▶) and
**refresh** (↻) are always there. Stop-all and restart-all reach every running task, including ones
this extension did not start.

Clicking an activity bar icon can only reveal its view, never run a command, so it cannot literally
do "what the toolbar icon does". If you would rather have the dropdown anyway, set
`taskRunnerUltimate.openDropdownFromActivityBar` to `true` and it opens as soon as the view is revealed.

### Favorites

The ☆ on a row — hover it, or right-click → **Add to Favorites** — pins that script to a
**FAVORITES** group at the very top of the tree, above even the packages that have something
running. In a monorepo the two or three scripts you actually use stop being buried under twenty you
never touch.

A favorite is a second way in, not a move: the script stays in its own package group as well. Since
it is listed away from that group heading, the FAVORITES row says where it came from — the package's
name, or the manifest path for a package that has none:

```
FAVORITES
  ▶ dev      api · vite dev
  ▶ dev      web · next dev
  🧪 test    api · vitest run
```

Click ★ to unpin. Order is the order you starred things in — new stars go to the bottom, so the list
stays where you put it.

In the tree a starred script appears twice, and the two rows are independent: running it from
FAVORITES and running it from its package group are the same task, and both rows spin. The dropdown
puts it at the top too, but lists it **once** — flattened into a single list, a second copy four rows
down reads as a duplicate rather than as a shortcut, so the row is lifted out of its package and
says where it came from instead.

### Renaming a row

Right-click a script → **Edit Title…** to call it whatever you actually call it. `dev` becomes
`API server`, and the row keeps the real script name in the dimmed text beside it, so you can still
see what runs:

```
▶ API server    dev · vite dev
```

The name in the manifest is never touched — this is a label on your side of the screen, not an edit
to the project's `package.json`. The renamed script stays findable by its real name in the dropdown,
which matches on that dimmed text too. Clear the input box to get the original name back.

The rename follows the script everywhere it is listed: the dropdown, the FAVORITES group and its own
package group all show the new title. The task terminal keeps the real name, since that is the one
the package manager is given.

### Reaching the row commands

**Add to Favorites**, **Remove from Favorites** and **Edit Title…** all act on the row they were
invoked from, so they live where there is a row to invoke them on:

| Command | Where |
| --- | --- |
| Add to Favorites | ☆ inline on hover, and right-click |
| Remove from Favorites | ★ inline on hover, and right-click |
| Edit Title… | right-click only — a rename is rare enough not to earn a permanent button |

All three are deliberately hidden from the command palette, which has no row to hand them. The
palette keeps the four that stand on their own: **Show Scripts**, **Refresh Scripts**, **Stop All
Running Tasks** and **Restart All Running Tasks**.

### Where favorites and titles are stored

In VS Code's own workspace storage (`ExtensionContext.workspaceState`), under the keys `favorites`
and `titles` — not in your `package.json`, and not in `.vscode/settings.json`. That storage is
already scoped to this extension and this workspace, so neither key can collide with anything and
neither shows up in a diff.

Starring a script is a personal note about a file the project owns, so the alternatives both have a
cost: the manifest is shared with everyone who clones the repo, and a setting would rewrite
`settings.json` on every click. Workspace storage keeps it out of both, at the price of it being
per-workspace and per-machine — a second computer starts with an empty FAVORITES.

Scripts are matched back by the workspace folder's name plus the manifest path inside it plus the
script name — `my-app/packages/api/package.json::dev` — rather than by absolute path. Moving the
whole project somewhere else on disk therefore keeps every star and every title; *renaming* the
folder does not.

A favorite whose manifest is temporarily out of the workspace is hidden, not forgotten: it stays in
storage and comes back with its folder. Deleting the script for real leaves a dead entry that costs
nothing and never shows.

## In the dropdown

The dropdown is the tree flattened — the same blocks in the same order, so the two surfaces are one
thing to learn rather than two:

```
Favorites (2) ────────────────────────
⟳ dev              web · vite dev        ⟳ ■
🧪 test            engine · cargo test    ⟳
Other tasks (1) ──────────────────────
⟳ tsc: watch       Workspace task        ⟳ ■
web — packages/web/package.json ──────
▶ build            next build             ⟳
🧪 test:e2e        playwright test        ⟳
engine — crates/engine/Cargo.toml ────
▶ run              cargo run              ⟳
⚖ clippy           cargo clippy           ⟳
Makefile ─────────────────────────────
▶ up               Start the stack        ⟳
🗑 clean           make clean             ⟳
```

Favorites first, then anything running that did not come from a manifest, then one block per
manifest — manifests with something running above the idle ones, and running tasks at the top of
their block. On a workspace with a single manifest and nothing starred the headings are dropped
entirely, since the only one there would be repeating the picker's own title.

| Action | Effect |
| --- | --- |
| `Enter` on a stopped script | Starts it and closes the picker, so the task terminal is visible. |
| `Enter` on a running task | Stops it; the picker stays open and refreshes in place. |
| `Shift+Enter` | Restarts the focused entry (starts it if it was stopped). |
| ⟳ button | Same as `Shift+Enter`, without leaving the keyboard row. |
| ■ button | Stops that task. Only shown for entries that are actually running. |

**Other tasks** covers running tasks this extension did not start — tasks from `tasks.json`, other
extensions, or the built-in npm task provider. Tasks that map onto a package.json script (our own and
`npm:` ones) are shown as that script, in its own package block, rather than duplicated — so a script
started from the built-in npm list can be stopped from here too.

Each row carries the same category icon as the tree, but not its colour. That one is out of an
extension's hands: VS Code turns a `ThemeIcon` into a plain codicon class on the way into a quick
pick and discards the `ThemeColor` — [`mainThreadQuickOpen.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadQuickOpen.ts)
carries a TODO to that effect. Only URI icons are drawn in colour there, and a pre-rendered SVG
cannot resolve a theme colour id, so the colours stay where they can follow your theme: the tree.

## Keyboard shortcuts

| Shortcut | Platform | Action |
| --- | --- | --- |
| `Ctrl+Cmd+T` | macOS | Opens the list, exactly like the ▶ icon in the editor title bar. |
| `Ctrl+Alt+T` | Windows, Linux | The same. |
| `Shift+Enter` | all | Restarts the focused entry — only while the list is open. |

The opening shortcut has no `when` clause, so it works from the editor, the terminal, the settings
tab, anywhere. The list opens as a normal VS Code quick pick, centred at the top of the window;
that position is fixed by VS Code and no extension can move it.

Both defaults were picked because VS Code leaves them free, which is worth spelling out — the
obvious candidates are not:

- `Cmd+Alt+R` toggles **regex** in the find widget on macOS (`Alt+R` on Windows and Linux).
- `Cmd+Alt+T` is **Close Other Editors** on macOS. That binding is mac-only, which is why plain
  `Ctrl+Alt+T` is still free on Windows and Linux.
- `Ctrl+Cmd+T` is bound to nothing at all on macOS, by VS Code or by the system.

### Changing it

Press `Cmd+K Cmd+S` (`Ctrl+K Ctrl+S`), search for **Task Runner Manager: Show Scripts** and click the
pencil. Or write it out in `keybindings.json`:

```json
{ "key": "cmd+alt+j", "command": "taskRunnerUltimate.show" }
```

That *adds* a shortcut. To retire the default as well, disable it with a leading `-`:

```json
{ "key": "ctrl+cmd+t", "command": "-taskRunnerUltimate.show" }
```

> On Ubuntu and most GNOME desktops `Ctrl+Alt+T` opens a system terminal, and the desktop takes the
> key before VS Code ever sees it. Rebind it there — the shortcut above is the way.

## Settings

Everything lives under `taskRunnerUltimate.*` and works in user settings as well as in a workspace's
`.vscode/settings.json`, so a repository can pin its own runner for everyone who opens it.

| Setting | Default | What it does |
| --- | --- | --- |
| `sources` | all nine | Which ecosystems are scanned: `node`, `rust`, `python`, `make`, `just`, `task`, `go`, `php`, `mise`. A removed one is never read. |
| `packageManager` | `auto` | Forces `npm`, `yarn`, `pnpm`, `bun` or `deno` instead of [detecting it](#runner-detection). Node only: `deno.json(c)` ignores it, and no other ecosystem is affected. |
| `cargoCommands` | `run`, `build`, `test`, `clippy`, `fmt` | The cargo subcommands every crate gets — see [Rust](#rust). |
| `goCommands` | `run`, `build`, `test`, `vet` | The go subcommands every module gets. |
| `pythonRunner` | `auto` | How `[project.scripts]` entry points are entered — see [Python](#python). `none` hides them. |
| `exclude` | `**/{node_modules,.git,dist,out,build,.next,coverage,target,vendor,__pycache__,.venv,venv,.tox,.nox,.mypy_cache,.pytest_cache}/**` | Glob of manifests to skip while scanning. Widen it in a large monorepo. |
| `showInEditorTitle` | `true` | The badged ▶ icon in the editor title bar. |
| `showInStatusBar` | `true` | The `Task Runner` entry in the status bar. |
| `openDropdownFromActivityBar` | `false` | Also opens the dropdown whenever the activity bar view is revealed. Off because the view already shows the same list as a tree. |
| `colorIcons` | `true` | Tints task icons by category. Turn off for plain foreground-coloured icons. |
| `categories` | `[]` | Extra category rules, checked *before* the built-in ones. |

The ones worth knowing about in a real project are `sources`, `exclude` and `packageManager`. A
monorepo that keeps packages outside the default skip list scans faster once `exclude` covers them,
dropping an ecosystem from `sources` stops those files being opened at all, and pinning
`packageManager` removes any doubt about which runner a Node script goes through.

`categories` decides the icon and colour of a row. Each rule matches the task name token by token
first, then the command behind it, so a task called `ci` that in fact runs `vitest` still gets the
test icon. A rule that repeats a built-in token overrides the built-in:

```json
"taskRunnerUltimate.categories": [
  { "match": ["bench", "perf"], "icon": "dashboard", "color": "charts.purple" }
]
```

`icon` is a [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) id and `color`
a theme colour id — either one of `taskRunnerUltimate.category.*` or any built-in such as
`charts.green`. The built-in categories are run, test, quality, build, release, data and clean, and
each has a `taskRunnerUltimate.category.<name>` colour you can override in
`workbench.colorCustomizations`.

## Behaviour

- Scans every manifest in [the table above](#what-gets-scanned), skipping `node_modules`, `target`,
  `.venv`, `vendor`, `dist`, `out`, `build`, `.next`, `coverage` and the rest (configurable via
  `taskRunnerUltimate.exclude`). `deno.jsonc` comments and trailing commas are tolerated, and both the
  string and the Deno 2 object task form (`{ "command": …, "description": … }`) are read.
- TOML, INI, Makefile, justfile and Taskfile parsing is done in-extension: the extension ships with
  no runtime dependencies, and a manifest that cannot be parsed is skipped rather than reported —
  the file belongs to the project, and a scan that threw would take the whole list down with it.
- Make skips pattern rules (`%.o:`), targets built out of a variable (`$(BIN):`) and the special
  ones (`.PHONY`); `just` skips `_`-prefixed and `[private]` recipes; go-task skips `internal: true`;
  cargo-make skips `private` and `disabled`; Composer skips its event hooks.
- In a monorepo the idle list is grouped per manifest, showing the package name and relative path.
- Tasks run through the VS Code **task** system (not a raw terminal), which is what makes running
  state, stop and restart reliable. Each task gets a dedicated task terminal that is cleared on
  restart. They also show up under **Run Task…** as `scripts: <name>`.
- A scan is capped at 2000 manifests. Reaching the cap is reported once, rather than quietly
  handing you a short list.

### Staying up to date

The list is cached, and the cache is dropped whenever anything a scan depends on changes: any
manifest in [the table above](#what-gets-scanned), and equally a lock or config file —
`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `package-lock.json`, `deno.lock`, `uv.lock`,
`poetry.lock` and the rest of the [detection signals](#runner-detection). Adding or removing a task
shows up on its own, in both the tree and an open dropdown. A setting that decides what is scanned —
`sources`, `exclude`, `cargoCommands`, `goCommands`, `pythonRunner` — does the same.

Detected runners are dropped along with it. That matters because `packageManager` and `engines` live
in the very file being edited: switching a package from npm to pnpm has to change how its scripts
are launched, not just what the list says. The cost is a rescan plus a few stat calls per package,
on a change you made yourself.

`Task Runner Manager: Refresh Scripts` does exactly the same thing on demand, for the cases no
watcher can see — a manifest edited outside the workspace, say.

## Runner detection

This is a Node question only. Every other ecosystem names its runner in the table the task is
declared in, or in the file name itself — the one exception, `[project.scripts]`, is covered under
[Python](#python). For a `package.json`, checked in this order, per package, first match wins:

1. `taskRunnerUltimate.packageManager`, if set to something other than `auto`.
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
  `taskRunnerUltimate.packageManager` is pinned to something else — no other runner can execute it.

### How the badge works

The activity bar badge is a real API (`TreeView.badge`). The toolbar one is not: editor title icons
are static images with no way to draw on them. So `media/` holds pre-rendered icons for counts 1–9
plus `9+`, one command per variant, and the extension publishes the running count into the
`taskRunnerUltimate.runningCount` context key — the `editor/title` menu then shows whichever variant
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
code --install-extension task-runner-ultimate-0.1.8.vsix --force
```

Reload the VS Code window after installing (`Developer: Reload Window`).
