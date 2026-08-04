# Package Scripts List

Collects every `scripts` entry from all `package.json` files and every `tasks` entry from all `deno.json(c)` files in the workspace and shows them in one
dropdown — together with every task that is currently running, so the same list starts, stops and
restarts them.

The toolbar icon is a filled disc with the play triangle knocked out of it, and carries a badge with
the number of running tasks: plain → ① … ⑨ → `9+`.

> The Command Center itself (the search field in the title bar) is **not** extensible: as of
> VS Code 1.131 the only extension-facing toolbar menus are `editor/title`, `view/title`,
> `scm/title`, `notebook/toolbar` and friends — `commandCenter/center` is internal. So the
> top-of-window button lives in the editor title bar, which is the closest available spot.

## Where the button appears

| Place | Notes |
| --- | --- |
| Editor title bar (top right) | Primary entry point, with the running-tasks badge. Toggle with `packageScripts.showInEditorTitle`. |
| Status bar (bottom left) | `$(play-circle) Scripts`, or `$(sync~spin) Scripts N` while tasks run. Toggle with `packageScripts.showInStatusBar`. |
| Command palette | `Package Scripts: Show Scripts` |
| Keybinding | `Cmd+Alt+R` / `Ctrl+Alt+R` |

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
  `packageScripts.exclude`). `deno.jsonc` comments and trailing commas are tolerated, and both the
  string and the Deno 2 object task form (`{ "command": …, "description": … }`) are read.
- In a monorepo the idle list is grouped per package, showing the package name and relative path.
- Scripts run through the VS Code **task** system (not a raw terminal), which is what makes running
  state, stop and restart reliable. Each script gets a dedicated task terminal that is cleared on
  restart. The scripts also show up under **Run Task…** as `scripts: <name>`.
- The script list is cached and invalidated when any manifest changes;
  `Package Scripts: Refresh Scripts` forces a rescan.

## Runner detection

Checked in this order, per package, first match wins:

1. `packageScripts.packageManager`, if set to something other than `auto`.
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
  `packageScripts.packageManager` is pinned to something else — no other runner can execute it.

### How the badge works

VS Code toolbar icons are static images — there is no API to draw a badge on one. So `media/` holds
pre-rendered icons for counts 1–9 plus `9+`, one command per variant, and the extension publishes
the running count into the `packageScripts.runningCount` context key. The `editor/title` menu shows
whichever variant matches. Regenerating the icons/manifest entries is a one-off script, not part of
the build.

## Development

```bash
npm install
npm run watch     # or: npm run compile
```

Then press <kbd>F5</kbd> ("Run Extension") to open a second VS Code window with the extension loaded.

To build and install a package:

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension package-scripts-list-0.0.1.vsix --force
```

Reload the VS Code window after installing (`Developer: Reload Window`).
