# Task & Script Explorer — Manual

Everything the extension does, in detail: what it scans, how it runs things, what every row and
button means, and what each setting changes. The [README](../README.md) is the short version.

### ▶ in the toolbar of every file

The play icon sits in the editor title bar, so the whole workspace is one click away from wherever
you happen to be. The count of running tasks lives on the activity bar icon and in the status bar —
the watcher you forgot about stays in the corner of your eye instead of hiding in a stack of
terminals.

### A hotkey, from anywhere

<kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>T</kbd> on macOS, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> on
Windows and Linux. Every task of every manifest in the workspace, without touching the mouse — from
the editor, the terminal, anywhere. Both defaults were picked because VS Code leaves them free, and
[changing them](#keyboard-shortcuts) takes one line.

### A panel in the left bar

Always there, whatever the active editor is: every task of every manifest, **grouped by the file it
came from**, each row carrying **its own icon and colour** for what it actually does — ▶ for dev
servers, a beaker for tests, a rocket for releases, a database for migrations. A running task spins
where it stands — no row and no group moves because something started inside it — and the count
rides on the activity bar icon as a real VS Code badge.

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

- **Every task, one list** — [eleven ecosystems](#what-gets-scanned): Node, Rust, Python, Make, just,
  go-task, Go, Composer, mise, Docker (compose files and Dockerfiles alike) and the `scripts/*.sh`
  every repository accumulates — grouped per manifest, or [per ecosystem](#grouping-by-ecosystem),
  with `node_modules`, `target`, `.venv` and build output skipped.
- **Searchable by command, not just by name** — type `vitest` and find the script that runs it.
- **Running tasks included** — even ones this extension did not start: tasks from `tasks.json`, other
  extensions, or the built-in npm list. Stop or restart them from the same place.
- **Toggle on <kbd>Enter</kbd>** — start what is stopped, stop what is running; ⟳ or
  <kbd>Shift</kbd>+<kbd>Enter</kbd> restarts, with a cleared terminal.
- **Two ways to start one task** — [click the row](#clicking-a-row-versus-pressing-run) and the terminal
  comes up with it; press ▶ and it starts in the background, leaving you where you were.
- **Click, click again, double-click** — one row, three gestures: run it, go back to its terminal,
  stop it. Nothing running is ever a single click away from being killed.
- **Show Terminal** — click a running row, or right-click it, to go to its output without stopping
  or restarting anything.
- **A compose file is one item, not a folder** — ▶ brings the stack up, ■ takes it down, and
  **Compose Commands…** in the right-click menu holds the rest: one `up` per service, plus `build`,
  `logs` and `ps`.
- **Add to Terminal** — right-click a shell row and a new terminal opens with its command line
  *typed but not run*, so a script can be given the arguments the tree has no way to ask for.
- **Jump to where a task is written** — right-click → **Go to Script Definition** opens the manifest
  at the line the task is on, wherever a task has one to point at; on a heading, **Open Manifest
  File** opens the file itself, and on a shell row it opens the script.
- **The file behind the row** — right-click a heading that names one, or a shell row, for **Copy
  Relative Path**, **Copy Path**, **Reveal in Finder** and **Reveal in Explorer View**, on the
  manifest the heading names, the folder a script group stands for, or the script itself.
- **Stop all / restart all** — for when the whole stack needs to go down or come back.
- **Favorites** — star the two or three tasks you actually run and they pin to the very top of the
  tree, above everything, without leaving the manifest they belong to.
- **Rename any row, and any heading** — `dev` becomes `API server`, `@acme/api-gateway` becomes
  `Gateway`. Display only: nothing on disk is renamed, and the real name stays findable.
- **Paint any row, and any folder** — fifteen colours in a right-click list, each drawn as a circle in
  its own colour, remembered per workspace, over the colour the task's category would have had.
- **A live count** — the number of running tasks, on the activity bar icon and in the status bar.
- **Knows your runner** — npm, yarn, pnpm, bun and deno, detected per package, overridable.
- **Real tasks, not typed-out terminal commands** — running state, stop and restart are reliable, and
  every task also shows up under **Run Task…**.

## What gets scanned

| Ecosystem | File | Tasks read from | Runs as |
| --- | --- | --- | --- |
| **Node** | `package.json` | `scripts` | `npm run` / `yarn run` / `pnpm run` / `bun run` — [detected](#runner-detection) |
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
| **Make** | `Makefile`, `makefile`, `GNUmakefile` | the targets | `make -f <file> <target>` |
| **just** | `justfile`, `Justfile`, `.justfile` | the recipes | `just --justfile <file> <recipe>` |
| **go-task** | `Taskfile.yml` and friends | `tasks:` | `task --taskfile <file> <name>` |
| **Go** | `go.mod` | the standard subcommands | `go test ./...`, … |
| **PHP** | `composer.json` | `scripts` | `composer run-script <name>` |
| **mise** | `mise.toml`, `.mise.toml` | `[tasks.*]` | `mise run <name>` |
| **Docker** | `compose.yml`, `docker-compose.yml`, their `.yaml` spellings, and profile names like `docker-compose.dev.yml` | `services:` — see [below](#docker-compose) | `docker compose -f <file> up <service>`, … |
| | `Dockerfile`, `Dockerfile.dev`, `api.Dockerfile` | one row per file, with the `FROM … AS <stage>` stages behind ☰ — see [below](#dockerfiles) | `docker build -f <file> --target <stage> -t <tag> .`, … |
| **Shell** | `**/scripts/**/*.{sh,bash,zsh,ksh,ps1,bat,cmd}`, the same under `**/bin/**/`, and `*.{sh,…}` in the root | the files themselves — see [below](#shell-scripts) | `bash ./scripts/deploy.sh`, `powershell -NoProfile -File ./bin/setup.ps1` |

Turn any of them off with `taskRunnerUltimate.sources` — a removed ecosystem's files are never
opened at all, which is also the fastest way to quieten a repository carrying a `Makefile` nobody
runs.

Make, just and go-task are the three that would otherwise go looking for their own file, and each
has its own idea of which one wins: `make` prefers a `GNUmakefile` to a `Makefile`, `task` prefers
`Taskfile.yml` to `Taskfile.yaml`, and `just` refuses to choose at all. So a row from one of them
names the file it came from — `make -f Makefile build` — and runs that file's task rather than
whichever the runner would have opened. It is named every time, including where the directory looks
like it holds only one: a file left out by `exclude`, or beyond the 2000-manifest cap, is invisible
to the scan and still there for the runner.

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
entries, `src/main.rs` named after the package, and every `src/bin/*.rs` — plus a `src/bin/<name>/`
directory when it holds a `main.rs`, which is what makes it a binary rather than a folder of shared
modules. Examples follow the same rule under `examples/`, and `autobins = false` or
`autoexamples = false` turns the walk off exactly as it does for cargo.

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

### Docker Compose

A compose file declares services, not tasks, so it is not a folder of rows the way a `package.json`
is. It is **one item**, and the item *is* the stack:

```
🖥 docker-compose.yml • services/stack        ■  ▶
```

▶ is `docker compose up` for the whole file and ■ is `docker compose down`. Neither needs the file
opened, because there is nothing to open: the row is a leaf. Everything else compose can be asked
for lives behind **Compose Commands…** in the right-click menu — one `up` entry per declared
service, and then the extra subcommands from `taskRunnerUltimate.dockerComposeCommands`, which is
`build`, `logs` and `ps` out of the box:

```
Compose command for docker-compose.yml
  ▶ Up web      docker compose -f docker-compose.yml up web
  ▶ Up db       docker compose -f docker-compose.yml up db
  build         docker compose -f docker-compose.yml build
  logs          docker compose -f docker-compose.yml logs -f
  ps            docker compose -f docker-compose.yml ps
```

`up` and `down` are not in that setting and cannot be taken out of it: they are the two buttons, and
a list that could remove them would be a stack with no way up. Known names get their usual flags,
anything else runs as `docker compose <name>`.

■ does two things in order, and the order is the point: it ends whatever of *this window's* tasks
the file has running, and only once every one of them has actually gone does it run `down`. A
`down` racing a live `up` is the stack being removed and raised again by turns, so a task that
would not stop stops the whole gesture — the warning about it is on screen, and nothing has been
removed. ▶ is the same care from the other side: a second `up` over a running one is never started.

The item also **spins while any part of the file is running** — one `up: web` out of six services
counts. It and a [Dockerfile](#dockerfiles) are the two items that do: every other heading is a file
or a folder that *holds* tasks rather than being one, and a spinner on all of them would be a column
of spinners in a monorepo with a single `dev` running.

Two details are deliberate. **Nothing is ever run detached**: a `-d` command exits the moment it
starts, which would leave the item idle with the containers still up and ■ with nothing to stop.
A `-d`, `--detach` or `--wait` (which implies detached mode) written into `dockerComposeCommands` is
dropped rather than honoured, and the entry is named by what it actually runs — so `up -d` is
listed, and behaves, as plain `up`. And `logs` is always followed (`logs -f`) for the same reason. If
you want a detached `up`, that is a terminal command, not a row that lies about its own state.

**Which files count.** The four names compose picks for itself — `compose.yaml`, `compose.yml`,
`docker-compose.yaml`, `docker-compose.yml` — are compose files by name alone. Beyond those, the
profile-named ones are found too: `docker-compose.dev.yml`, `compose.prod.yaml`,
`docker-compose.ci.yml`, each a heading of its own. Nothing inside a YAML file says "I am compose",
so a name matched that way is only believed once the file shows a top-level `services:` or
`include:` block. A `deploy.staging.yml` never even gets that far, and neither does `composer.yml` —
the name has to begin with `compose` or `docker-compose` followed by a dot. Any name with
`.override.` in it is never a heading: `compose.dev.override.yml` is a fragment by every convention
there is, and running one on its own would ask compose to bring up services with no image.

Every row passes `-f <file>`, because what the scan saw is not what compose would pick — it has its
own precedence across those four names. Passing `-f` turns off the automatic merge of the override
file, though, and that file is a live development workflow, so the first of compose's **own four**
override names beside the manifest — `compose.override.yaml`, `compose.override.yml`,
`docker-compose.override.yaml`, `docker-compose.override.yml` — is appended as a second `-f`: the
merge compose would have done, spelled out. Note that compose searches those four in its own order
whatever the base file is called, so `compose.yaml` beside `compose.override.yml` is a pair — and
that this only applies to the four default names. A `docker-compose.dev.yml` gets no override, because the merge is something compose
does to the file it chose for itself.

`taskRunnerUltimate.dockerCompose` chooses between `docker compose` (the default — the v1 binary has
been end-of-life since July 2023) and `docker-compose`. There is no `auto`: the only honest way to
tell them apart is to run `docker compose version`, and a scan never starts a process.

#### Knowing what is actually up

A row spins while **this window** is running it, which is honest and incomplete: a stack you brought
up from a terminal, from Docker Desktop, or with `up -d` leaves every row looking stopped.

**Check containers** in [the ⋮ menu](#the-menu) asks Docker. It runs `docker compose ps` once per
compose file — `--format json`, and if the runner turns out not to have that flag (the standalone v1
binary does not) the same question again as `ps --services --filter status=running`, which v1 does
understand — and marks the rows whose containers are up — the `up: <service>` row for each running
service, and the bare `up` row whenever anything in that file is up. A marked row keeps its own icon,
takes the running colour, and reads `up ·` before its command. A row wearing an icon from your icon
pack keeps the `up ·` and not the colour — that artwork cannot be tinted. Those rows are the ones in
[the dropdown](#in-the-dropdown) and in the starred list: in the tree a compose file is a single item,
and ▶ and ■ sit on it whichever way Docker last answered.

It is a question you ask, not a background poll: that would mean a process per compose file on a
timer, in every workspace, for something most of them never need. The answer is refreshed on its own
in one place only — when a task of *this* window that names a compose file you have already asked
about ends, which is the one moment it is known to be stale. That covers `up`, `down` and the ■
below alike. Everything else waits for the next time you ask, and the files are asked in small
batches so a monorepo of per-service compose files does not put dozens of docker processes up at
once.

When Docker cannot answer — not installed, daemon down, the call times out after five seconds — the
rows keep whatever they last said rather than claiming everything stopped. "I could not ask" is not
"your stack is down".

■ on a row marked this way runs `docker compose stop` for that file or service, as an ordinary task
with its own terminal. The task belongs to the row you pressed, so that row spins while its own stop
runs and settles when the re-check comes back. `stop` and not `down`, because the square on a *row*
promises a stop: `down` would also delete the containers and their networks. The ■ on the compose
item in the tree is the other promise and says so in its name — **Compose Down** — because there the
square is the whole stack coming down, containers and networks with it.

This is the one thing in the extension that starts a process. Everything else reads the workspace
through VS Code's own file API, which is what keeps it working over Remote SSH and in Dev Containers;
the code for this lives in a file of its own, `src/containers.ts`, so the boundary is visible.

### Dockerfiles

A Dockerfile declares build stages, not tasks, so — like a compose file — its actions are the
`docker` subcommands worth having on a list: `build`, and `run` by default, set by
`taskRunnerUltimate.dockerfileCommands`.

And like a compose file it is **one row rather than a folder**: a Dockerfile *is* the image, so the
file itself is what you press. `build` is on ▶, and everything else is behind the ☰ beside it —
which is where the fan-out goes. Every named `FROM … AS <stage>` gets an entry of its own that passes
`--target`, so the intermediate stages of a multi-stage build are one click each rather than a
command you have to remember:

```text
🐳 Dockerfile • apps/api                     ☰ ▶
     ↳ ☰  build: deps      docker build -f Dockerfile --target deps -t api/deps .
        ☰  build: builder  docker build -f Dockerfile --target builder -t api/builder .
        ☰  run             docker run --rm -it api
```

The row spins while any of them runs, and ■ beside it ends whatever it started. A stage with no name
is not an entry: `--target` needs one. The bare `build` stays even when the last
stage is named, because `docker build` with no target is what most people want and the menu reads the
same whatever the file holds.

**The image reference.** Nothing in a Dockerfile says what the image should be called, and a
`docker build` with no `-t` leaves a dangling image with an id for a name. So the folder is the
name — the same thing compose does for a project that does not name itself — lowercased and reduced
to what Docker accepts.

The two things that tell the Dockerfiles of one folder apart take one half of the reference each:
the **stage** is a path segment on the repository, the **profile** from the file name is the tag. In
`apps/api` that gives

| file | target | builds |
| --- | --- | --- |
| `Dockerfile` | — | `api` |
| `Dockerfile` | `builder` | `api/builder` |
| `Dockerfile.dev` | — | `api:dev` |
| `Dockerfile.dev` | `builder` | `api/builder:dev` |

so no two of the rows **this extension derives** can build over each other. Joining the two into one
tag could: a `Dockerfile.dev` with no target and a `Dockerfile` targeting a stage called `dev` would
both read `api:dev`, and the second build would silently retag the first — after which `run` starts
an image built from the other file. No separator fixes that, because every character Docker allows in
a tag it also allows in a stage name.

The folder name is reduced to alphanumeric runs joined by `-`, because Docker's grammar for that half
rejects things a folder may well be called — `my..app` and `a___b` are both `invalid reference
format`. Dots go too, and deliberately: Docker reads a first component carrying one as a *registry
domain*, so a folder called `example.com` would have made `push` push at a real remote. It builds
`example-com`. The tag half is cut at Docker's limit of 128 characters.

Three things it does **not** promise:

- Two Dockerfiles in **different** folders of the same name share a repository —
  `services/api/Dockerfile` and `tools/api/Dockerfile` are both `api`. The parser reads one file at a
  time and cannot see the other.
- The two naming conventions for one word are the same image: `Dockerfile.dev` and `dev.Dockerfile`
  in one folder both build `api:dev`. Use one convention per folder.
- An entry of your own in `dockerfileCommands` that omits `-t` reuses the image name, so
  `build --platform linux/arm64` writes over what the bare `build` made.

For any of the three, name the image yourself: a `-t` in your own entry **replaces** the derived one
rather than being added beside it.

**The context** is the directory the Dockerfile sits in, which is also the directory every row runs
in. A Dockerfile kept in `docker/` and built from the repository root is a real layout, but nothing in
the file says so — so the default is the honest one every other manifest here uses.

**Which files count.** `Dockerfile` and `dockerfile`, plus both profile conventions:
`Dockerfile.dev` and `dev.Dockerfile`, each a heading of its own named after its file. A file holding
no `FROM` at all declares no rows.

That last check is not what keeps a file that is *about* a Dockerfile off the list, because it cannot
be: a template is a Dockerfile textually, and a document explaining how to write one is the file most
likely to quote a `FROM`. So `Dockerfile.<suffix>` is refused outright for the suffixes that say the
file is not a build — what a merge, a patch or an editor leaves behind (`.orig`, `.rej`, `.bak`,
`.save`, `.swp`, `.tmp`, `.patch`, `.diff`), what documentation is written in (`.md`, `.markdown`,
`.txt`, `.rst`, `.adoc`), and the template engines whose output is the real Dockerfile (`.template`,
`.tmpl`, `.tpl`, `.j2`, `.jinja`, `.jinja2`, `.erb`, `.mustache`, `.hbs`, `.in`, `.gotmpl`). The last
dotted segment decides, so `Dockerfile.dev.orig` is refused on the `orig`. Only that spelling is
tested: in `<name>.Dockerfile` the word is a name you chose, so `template.Dockerfile` is a row.

**Commands.** Each entry in `dockerfileCommands` is split on whitespace into a verb and its
arguments — quoting is not preserved — and the **verb alone** decides what the row is. The known
verbs are `build`, `run` (`--rm -it`, so a row you pressed four times does not leave four stopped
containers behind) and `push`, and each splices your arguments where they belong: `build --no-cache`
still carries its `-f`, its `-t` and its build context, and `run --name api` puts the flag before the
image `run` takes last. A verb that is none of the three runs as `docker <verb> <arguments>` with no
`-f` and no image appended, so `builder prune` and `image ls` mean what they say.

Where you name the image yourself, yours is the one used: a `-t` or `--tag` on a `build` entry
replaces the derived reference, a `--target` on one is what the reference is derived *for*, and a
reference written into a `push` entry replaces it too — `push` takes exactly one, so it could not be
appended beside yours. `run` is the exception and always appends: too many of its options take values
of their own for a bare word to be read as an image without sometimes being wrong, so run a different
image with a verb of your own instead.

Only the bare `build` fans out per stage; a verb carrying arguments is the one row that was asked
for, which is the rule the compose rows already follow for `up`. Nothing is ever run detached: `-d`,
`--detach` and any bundle of short options carrying `d` — `docker run -dit` is Docker's own
spelling — are dropped, and the row is named by what is left, so `run -d` is listed, and behaves, as
plain `run`. `--detach-keys`, which sets a key sequence rather than detaching, is left alone.

One caveat `run` inherits from Docker: `docker run` does not forward signals while a tty is
allocated, so stopping the row kills the CLI and leaves the container up with `--rm` unfired. The
compose half of this extension has **Check Containers** and a ■ that reaches real containers; the
Dockerfile rows do not, so a container left this way is yours to `docker rm`.

`docker` is not configurable the way `taskRunnerUltimate.dockerCompose` is, because there is no
second spelling of it: compose forked into a plugin and a standalone binary, and `docker build` did
not.

### Shell scripts

Every script under a `scripts/` or `bin/` folder — at any depth, so a package of a monorepo gets its
own — or in the root of a workspace folder becomes a row, and in `flat` grouping the scripts of one
project are drawn together under a single **`shell`** heading with a terminal on it, however many
folders they came from. `taskRunnerUltimate.shellScripts` is the list of globs, matched against each
file's path relative to its workspace folder. The first two carry a leading `**/` for exactly that
reason; the third does not, so loose scripts are listed where a project root is rather than in every
directory. The heading is then drawn [inside the nearest project above
it](#what-a-project-takes-in-with-it).

Seven extensions are read: the Bourne family — `.sh`, `.bash`, `.zsh`, `.ksh` — and the three Windows
writes its scripts in, `.ps1`, `.bat` and `.cmd`. Which one a file carries decides two things and
nothing else: the words it is run through, and the terminal its row wears — bash, PowerShell or the
command prompt, so a column of scripts says what each one is before you read its name.

The dimmed text is the first comment line in the file written for a person — the shebang, and the
`# shellcheck`, `# vim:` and `# -*-` pragmas under it, are skipped. A batch file's `REM` and `::`
count as comment openers too:

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2086
# Deploy the API to staging.     ← this is what the row shows
set -euo pipefail
```

A row runs **from the workspace folder root**, which is where a `scripts/*.sh` is nearly always
written to be run from. What goes in front of the path is decided by the extension:

| Extension | Runs as | Setting |
| --- | --- | --- |
| `.sh`, `.bash`, `.zsh`, `.ksh` | `bash ./scripts/deploy.sh` | `taskRunnerUltimate.shellRunner` |
| `.ps1` | `powershell -NoProfile -File ./bin/setup.ps1` | `taskRunnerUltimate.shellRunners` |
| `.bat`, `.cmd` | `./bin/run.bat` — a program to Windows already | `taskRunnerUltimate.shellRunners` |

`shellRunner` empty runs a Bourne-family path on its own, which then needs both the executable bit
and a shebang; on Windows it wants Git Bash or WSL on the `PATH`. `shellRunners` is the same thing per
extension, and an extension it does not name falls back to `shellRunner`. `powershell` and not `pwsh`
because Windows PowerShell 5.1 ships with the OS — on PowerShell 7, set `pwsh -NoProfile -File`, and
where an execution policy blocks the script, `powershell -NoProfile -ExecutionPolicy Bypass -File`.
Stepping over the machine's policy is deliberately not the default.

A script that takes arguments has nowhere to say them — the tree runs what the file is and nothing
more — so right-click → **Add to Terminal** opens a new terminal at the same working directory with
the same command line *typed into the prompt and not run*:

```
$ bash ./scripts/deploy.sh ▏          ← the cursor is here; type the rest and press Enter
```

Nothing is remembered and nothing is prompted for: it is a terminal, with a line in it to finish,
edit or throw away. Anything in the line that is not a plain path or task name is quoted literally
for the shell that terminal opens in — a script checked out as `$(id).sh` is typed as text, not as a
substitution waiting for the Enter key.

The executable bit is deliberately not consulted. It is invisible through VS Code's own file API —
`FilePermission` carries only `Readonly` — so reading it would mean importing `node:fs`, and that is
what would break Remote SSH and Dev Containers. The convention is the signal instead: a script in
`scripts/`, `bin/` or the root.

At most 200 scripts are read per scan, budgeted apart from the manifests so a repository full of
them cannot crowd out real tasks. Because that cap and those globs decide what is *seen* rather than
what exists, a shell row is never grounds for forgetting a star, a rename or a colour — unlike a
manifest, whose contents are read whole, a script missing from the list may only have been narrowed
out. The cost is the one this extension always pays here: a script deleted for real keeps its marks,
exactly as a package behind a closed workspace folder does.

This is the one source that ships enabled *and* changes an existing tree on upgrade; `shell` out of
`taskRunnerUltimate.sources` is the way back.

## Where the button appears

| Place | Notes |
| --- | --- |
| Editor title bar (top right) | The ▶ icon. Toggle with `taskRunnerUltimate.showInEditorTitle`. |
| Activity bar (left strip) | The **Task & Script Explorer** view: the same list as a tree, with a native count badge. Always visible, whatever the active editor is. |
| File Explorer (bottom section) | The same tree again, as a **Task & Script Explorer** section under the file list — collapsed until you open it, so it costs one row until you want it. Toggle with `taskRunnerUltimate.showInFileExplorer`. |
| Status bar (bottom left) | `$(play-circle) Tasks`, or `$(loading~spin) Tasks: N` while tasks run, followed by Restart all and Stop all buttons whenever something is running. Toggle with `taskRunnerUltimate.showInStatusBar`. |
| Command palette | `Task & Script Explorer: Show Scripts` |
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

### The Task & Script Explorer view

The activity bar icon opens a tree with the same content as the dropdown, in this order: the
[starred tasks](#favorites) first — as loose rows with no heading over them, or under a **Favorites**
folder when [grouping by ecosystem](#grouping-by-ecosystem) is on — then **OTHER TASKS** —
anything running that this extension did not start — then one group per manifest, in the order the
scan found them in and [your drags](#reordering-rows) put them in, each with its own compose files
and script folders [inside it](#what-a-project-takes-in-with-it). Nothing moves because something
started: neither the groups nor the rows inside them — a running task spins in the place it has
always had, because a row that jumps when you start it is a row you have to find again to stop it. Set
`taskRunnerUltimate.pinRunningTasks` to `true` if you would rather have the opposite: running tasks
then come first inside their own group, in the tree and in the dropdown alike. Clicking
a row runs it, clicking a running one goes to its terminal, and a double click stops it —
and hovering one reveals inline ☆ / ▶ / ⟳ / ■ buttons. The count of running tasks rides on the activity bar icon as a real VS Code
badge.

Each heading wears **its own file's icon**, taken from whichever file icon theme you run — the real
npm, Rust and Docker marks, which no icon font carries. A folder of shell scripts is the one heading
with no file behind it, and a theme can only match on a file name, so it wears a terminal instead.
`taskRunnerUltimate.groupIcons: "uniform"` puts a single stack glyph back on all of them, for when the
headings should stay out of the way of the rows under them.

A task row wears its [category's glyph](#categories-and-colours), and a shell row that no category
claimed wears the terminal its file is read by — bash for a `.sh`, PowerShell for a `.ps1`, the
command prompt for a `.bat` — where every unclaimed row used to show the same `play` triangle.

The colour is a separate thing from the icon, and stays yours: a heading is tinted when **you**
[paint it](#painting-a-row), the tint lands on the text and leaves the icon its own colours, and an
unpainted heading reads in the same colour as every other. A colour per ecosystem was tried and taken
out — a colour nobody chose on every row is the one job the paint is for, and eleven tints down one
column made the headings the loudest thing on screen.

Ecosystem rows are the exception, since they name no file: those keep a glyph of their own in both
modes — a box for Node, a gear for Rust, a crate for Docker, a terminal for shell. A `shell` heading
standing for several folders is the same kind of row and keeps its terminal too; one standing for a
single folder is that folder, and follows `groupIcons` like any other heading.

#### What a project takes in with it

A `docker-compose.yml` and a `scripts/` folder describe what is *around* a project rather than
something beside it — they reach across every folder under the project root — so they are drawn
inside the project's own heading:

```
acme
  ▶ dev
  ▶ build
  🖥 docker-compose.yml
  💻 shell [3]
     ▶ deploy.sh     scripts
     ▶ lint.sh       tools/ci
     ▶ release.sh
```

Each one looks for the nearest folder **at or above its own** that holds a project manifest —
`package.json`, `deno.json`, `composer.json`, `Cargo.toml`, `pyproject.toml` or `go.mod` — and goes
under that. In a monorepo `apps/web/scripts/*.sh` therefore lands in `apps/web`, not at the root.

A `Makefile`, a `justfile`, a `Taskfile` or a `mise.toml` is a task runner rather than a statement
that the folder *is* a project, so a folder holding only one of those hosts nothing and the compose
file keeps a heading of its own — as it does anywhere with no project above it at all.

A compose file is named by its file, since a folder can hold `docker-compose.yml` and
`docker-compose.dev.yml` at once. Script folders are not named at all: `scripts/`, `bin/` and
`tools/ci` under one project are a single **`shell`** row, since three headings would each say only
that there are scripts here. Where more than one folder is in the row, each script says which it came
from in the dimmed column, and a script in the project's own folder has no path to name.

The number in brackets is how many scripts are under the fold — this is the one heading named after
what it holds rather than after a file or a package, and the count is the rest of that sentence. A
single script gets no number: `shell [1]` counts where there is nothing to count. A rename replaces
the whole heading, count and all.

A `shell` row that stands for **one** folder *is* that folder: it can be renamed, put away, painted
and opened exactly as it always could. One standing for several names nothing on disk, so — like an
ecosystem row — it folds, takes a colour and an icon and stops everything under it, and offers no
rename or hide.

**Hiding the project hides what it took in.** Putting `acme` away is putting that folder away, so its
compose file and its `shell` row go into **hidden** with it, still nested inside it — opening the
pile shows the package you put away, not its contents tipped out beside it. They carry no eye of
their own while they are in there: neither was put away in its own right, and both come back the
moment the project does. Hiding one of them on its own still works, and lands it in the pile as a row
of its own. In `ecosystem` mode nothing is nested anywhere, so nothing travels.

Whatever a heading leads with, the half after the bullet is the **folder** it lives in and never the
file name again: `docker-compose.yml • apps/web`, not `docker-compose.yml • apps/web/docker-compose.yml`.
Where that folder would only repeat the name, or where there is no path left to show, the bullet goes
too — a lone `compose.yaml` in the root is just `compose.yaml`. The full path stays in the tooltip.

The one exception is two headings in the same folder that lead with the **same** text, which is what a
napi-rs, neon, wasm-pack or maturin package is: a `Cargo.toml` beside a `package.json`, both declaring
the same name. Neither row says anything the other does not, so there — and only there — the bullet
carries the manifest path instead: `mylib • crates/mylib/Cargo.toml` beside
`mylib • crates/mylib/package.json`. Two headings that already differ are left alone; `engine • svc`
beside `Makefile • svc` needs nothing more.

Nothing about this is stored: the relationship is the paths, worked out on every repaint. That is
also why a drag cannot move one of these rows out of its project — the order would be rewritten and
the next repaint would put the row straight back, so the drop is refused with a note in the status
bar instead.

#### Grouping by ecosystem

By default every manifest heading sits at the top level, which in a polyglot repository is one long
column. Press the **grouping switch** in [the view header](#the-task--script-explorer-view) — or pick
**Group by ecosystem** from [the ⋮ menu](#the-menu), or set `taskRunnerUltimate.grouping` to
`"ecosystem"` — and they gather one level down, under a row per language or runner:

```
Node (2)
  web • apps/web
    ▶ dev
  api • services/api
    ▶ start
Rust (1)
  engine • crates/engine
    ▶ run
Docker (1)
  docker-compose.yml
Shell (2)
  apps/web/scripts
    ▶ deploy.sh
  tools/ci
    ▶ lint.sh
```

[Starred tasks](#favorites) get a heading of their own in this mode — a **Favorites** folder pinned
above the ecosystem rows, open by default. In the flat layout they sit loose at the root, which works
because nothing above them has a heading; here every root row does, and loose rows would read as
belonging to the first ecosystem.

Here a compose file is filed under **Docker** and a script folder under **Shell**, rather than under
the package they serve: the question this mode answers is what kind of thing a row is, so the
nesting above is switched off and the files themselves are what each ecosystem row opens into.

A script folder is the one heading drawn as its **path alone**, with no name before the bullet. Every
one of these rows is called `scripts` or `bin`, so leading with that put the word they all share
where the eye looks first and the half that tells them apart behind it — `scripts • apps/web` beside
`scripts • apps/api`, a column read by its tails. The path is the name here, which is what
[the dropdown](#in-the-dropdown) has called these rows all along.

An ecosystem row is a row like any other in the ways that matter: fold it and the fold survives a
reload, paint it, give it an icon, and stop or restart everything running anywhere under it. It is
*not* renameable or hideable — there is no name on disk for a rename to restore, and hiding a whole
ecosystem is what `taskRunnerUltimate.sources` does properly.

Dragging still works, with one boundary: a package moves inside its own ecosystem, and an ecosystem
row drags its whole block above or below another. A package dropped on a foreign ecosystem is
refused with a note in the status bar rather than snapping back — the tree cannot grey out a
forbidden target while the mouse is over it, so it says so instead.

The dropdown follows: the same order, with the ecosystem naming the first separator of each run.

#### Clicking a row versus pressing Run

The two ways of starting a task differ in one thing: whether the panel comes up with it.

Clicking the row **runs it and shows its terminal**. The whole row is one gesture saying "run this",
and what you wanted was the output — starting a dev server and then going to look for its terminal
is a step the click already meant.

Clicking a row that is **already running** goes back to that terminal, and nothing else: a second
look at a dev server's log is what that click is nearly always for. **Stopping it is a double
click**, so a task is never killed by a click meant to find its output. Both gestures are written
into the right-click menu — **Run (Click)**, **Stop (Double-Click)**, **Show Terminal (Click)** —
next to the inline ▶ and ■ buttons, which still act on one press.

The inline ▶ (and ⟳) **start it and leave you where you are**. That is the other intent: kicking off
a build or a codegen next to the file you are reading, without the panel taking the editor's place.
The terminal is still created and still keeps every line of output — it is one click away in the
terminal dropdown, and the row spins meanwhile — it just does not come to the front.

The way back is a click on the running row, or right-click → **Show Terminal**: either brings up
that task's terminal and focuses it, without stopping or restarting anything. Both work on the rows
under **OTHER TASKS** too, so a watcher some other extension started is one click from its output as
well.

A group is one manifest, not one directory: a Rust service with a `Cargo.toml`, a `Makefile` and a
`justfile` side by side gets three, all in the same folder.

Every group starts expanded bar one, and one you fold shut stays shut — through a repaint and across
a restart. Like the stars and the renames, the folds live in the workspace's own storage, so they are
per-workspace and per-machine and never reach `git status`.

The one that starts shut is **hidden**, whose whole point is to be out of the way. A **compose file**
and a **Dockerfile** are not on that list any more for a better reason: neither folds at all. One
compose file is seven rows where a `package.json` is seven scripts, and most of them — `build`,
`logs`, `ps` — are things you go looking for rather than press; a Dockerfile is the same case, where
`build` is the row and the stages are variations on it. So each is a single item
([compose](#docker-compose), [Dockerfile](#dockerfiles)) with its buttons and a menu, and there is
nothing left to open.

Every heading is read in the same two parts — **name, bullet, path**:

```
acme-platform
@acme/api-gateway • packages/services/api-gateway
@acme/frontend • apps/web
engine • crates/engine
docker-compose.yml • infra
```

The name comes first: what the package calls itself — `name` in a `package.json`, `[package] name`
in a `Cargo.toml`, `module` in a `go.mod`. That is the name the package is known by everywhere else
— in an import, in a `pnpm --filter`, in the starred rows at the top of the tree — and it is not
always the folder it lives in: `@acme/frontend` checked out at `apps/web` reads as itself, not as
`web`. A manifest that names nothing — a Makefile, a justfile, a `package.json` with no `name` —
falls back to the folder it sits in, and to the file name where that folder holds another manifest
as well, since there the file name is the only half that tells the two groups apart. A compose file
always leads with its own file name, because one folder can hold several.

Then, after the bullet, the **folder** it lives in — never the file name a second time — so it can be
pasted into a terminal. In a multi-root workspace the path begins with the workspace folder, which is
what keeps two packages of the same name in two projects apart. Where the folder would only repeat
the name, or where there is none left to show, the bullet goes with it: a root `package.json` named
`acme-platform` is just that, and so is a lone `compose.yaml` in the root.

The project is not repeated on every row. It opened every heading once and in a monorepo that meant
printing one word down the whole sidebar — a masthead that is on every row is not a masthead. It is
still named once, on the row of the manifest it came from: the project's root package is a group
like any other.

Nothing in the row is re-cased. `acme-platform`, `webUI` and `iOS` are decisions somebody made, in a
manifest or on disk, and a heading that tidied them up would disagree with the project about what it
is called — and the path after the bullet would stop being one you can paste into a terminal.

Any heading can be [renamed](#renaming-a-group-heading) when what it says is longer than the sidebar
has room for.

Every group heading carries an icon for what it is: ∿ for the tasks this extension did not start,
and, for a package, the icon its own manifest has in your file icon theme — so `package.json` wears
npm's mark and `Cargo.toml` wears Rust's. Only the icon varies; the colour of a heading is the same
on all of them unless you [paint one](#painting-a-row), which is what keeps the column from competing
with the rows under it. `taskRunnerUltimate.groupIcons: "uniform"` puts a single stack (≣) back on
every heading.

The view header holds five actions. **Restart all** (⟳) and **stop all** (◼) appear only while
something is running, so the header stays quiet on an idle workspace; **open the dropdown** (▶), the
**grouping switch** and the **menu** (⋮) are always there. The switch is one button drawn as whichever
mode it would put you in — a tree (⊞) while the list is flat, a flat list while it is
[grouped by ecosystem](#grouping-by-ecosystem) — so the header never shows you the mode you are
already in. Stop-all and restart-all reach every running task, including ones
this extension did not start.

A restart waits for the stop to actually happen before it starts anything back up, and if a task will
not go — fifteen seconds after being asked, still listed as running — it says so and stops there
rather than launching a second copy beside the first. Restart-all calls the whole round off on one
such task; a restart on a package heading skips only that row.

### Renaming the heading

`taskRunnerUltimate.title` is what the section header says — `Task & Script Explorer` until you make
it something shorter, or something in your own language:

```json
"taskRunnerUltimate.title": "Скрипты"
```

It lands on both places the tree is drawn: the view in the activity bar and the section at the foot
of the File Explorer. One character is enough and a hundred is the ceiling; an empty string, or one
with nothing but spaces in it, falls back to the default rather than leaving a header with nothing
to read.

What a rename does not reach is the tooltip on the activity bar icon itself. A view container's
title is read out of the manifest when the extension is installed and there is no API to change it
afterwards, so the icon keeps the extension's own name.

### The menu

The ⋮ in the view header opens everything that is not aimed at one row:

| Entry | What it does |
| --- | --- |
| **Refresh scripts** | Reads every manifest again. Rarely needed — the manifests are watched — but there when a scan has gone stale. |
| **Settings** | Opens the settings editor filtered to this extension, so all of [the settings](#settings) are in one list. |
| **Check containers** | Asks Docker which compose services are actually running and marks those rows — see [Knowing what is actually up](#knowing-what-is-actually-up). Nothing happens in the background; this is the question. |
| **Group by ecosystem** | Toggles [the hierarchical layout](#grouping-by-ecosystem), saying `on` or `off` as it stands now — the same switch the view header carries as a button. Written to your user settings, so a click here never adds `.vscode/settings.json` to the project's `git status` — unless the setting is already pinned in the workspace, where the write goes instead, since a global one would be shadowed by it. Where something with the last word still holds the value — a folder setting, a policy — the click says so rather than doing nothing. |
| **Reset all applied styles** | Restores every custom title, colour and icon while leaving favorites, visibility, ordering and folded groups untouched. |
| **Reset all titles** | Every [renamed](#renaming-a-row) row and group heading goes back to the name its manifest gives it. |
| **Reset sort order** | Every list goes back to the order its manifest declares, undoing [the drags](#reordering-rows). |
| **Reset all colours** | Every [painted](#painting-a-row) row and group heading goes back to the colour its category gives it. |
| **Reset all icons** | Every customized row and group heading goes back to its default icon. |
| **Remove favorites** | Unstars everything, so the rows at the top disappear. The tasks stay where they are, in their own packages. |
| **Reset all confirmations** | Every [guarded](#asking-before-a-task-starts-or-stops) task goes back to starting and stopping straight away. |
| **Show hidden packages** | Restores every hidden package to its saved place in the tree. This entry is separated at the bottom of the individual resets. |
| **Reset all changes for this project** | Clears all list customizations for this project, including favorites, hidden packages, ordering and folded state. |

Each reset says how much it is about to throw away — `3 renamed`, `2 lists reordered`, `4 painted`,
`5 starred`, `2 guarded` — and asks once before it does it. The two broad resets are separated from the
individual actions they bracket. Refresh is also in the command palette under
**Task & Script Explorer: Refresh Scripts**.

Clicking an activity bar icon can only reveal its view, never run a command, so it cannot literally
do "what the toolbar icon does". If you would rather have the dropdown anyway, set
`taskRunnerUltimate.openDropdownFromActivityBar` to `true` and it opens as soon as the view is revealed.

### Favorites

The ☆ on a row — hover it, right-click → **Add to Favorites**, or [drag the row onto another starred
row](#reordering-rows) — pins that script to the very top of the tree, above every package. In a
monorepo the two or three scripts you actually use stop being buried
under twenty you never touch.

In the default `flat` layout there is no folder over them. A heading above the two or three tasks you
run all day is a fold to open before you can click them, so the starred rows sit loose at the root,
already in reach:

```
  ▶ dev      api · vite dev
  ▶ dev      web · next dev
  🧪 test    api · vitest run
@acme/frontend • apps/web ────────────
  ▶ build    next build
```

With [grouping by ecosystem](#grouping-by-ecosystem) on, every other root row is a heading, and bare
task rows above them read as belonging to the first ecosystem rather than as a list of their own.
There the stars get a **Favorites** folder of their own, pinned above everything and open by default
— the lid costs nothing when it starts open, and it is what says where the starred list ends:

```
⭐ Favorites (3) ─────────────────────
  ▶ dev      api · vite dev
  ▶ dev      web · next dev
  🧪 test    api · vitest run
📦 Node (2) ──────────────────────────
  @acme/frontend • apps/web ──────────
    ▶ build  next build
```

It folds, paints and takes an icon like any other heading, and dropping a task on it stars that task
at the end of the list.

A favorite is a second way in, not a move: the script stays in its own package group as well. Since
the starred row is listed away from that group heading, it says where it came from in its dimmed
text — the package's name, or the manifest path for a package that has none. That is also what tells
the two rows apart at a glance.

Click ★ to unpin. Order is the order you starred things in — new stars go to the bottom, so the list
stays where you put it — and it can be [dragged](#reordering-rows) into any other order.

In the tree a starred script appears twice, and the two rows are independent: running it from the top
of the list and running it from its package group are the same task, and both rows spin. The dropdown
puts it at the top too, but lists it **once** — flattened into a single list, a second copy four rows
down reads as a duplicate rather than as a shortcut, so the row is lifted out of its package and
says where it came from instead.

### Asking before a task starts or stops

Right-click a task → **Enable Confirmation**. From then on that one row asks before it does anything:

```
┌──────────────────────────────────────────────┐
│  Run "deploy"?                               │
│                                              │
│  This task asks before it starts. Turn that  │
│  off with "Disable Confirmation" in its      │
│  context menu.                               │
│                                              │
│                        [ Cancel ]  [ Run ]   │
└──────────────────────────────────────────────┘
```

It is a toggle, so the same place turns it back off — the entry reads **Disable Confirmation** once it
is on, and there is only ever one of the two on the menu. A guarded row says so in its tooltip
(*Asks before it starts or stops*) and looks like every other row otherwise: a badge for a state you
set once and then want to stop thinking about would cost a column of every row to say nothing about
most of them.

It covers every way a single row is started or stopped — the ▶ and ■ buttons, the click and the
double click, **Run** and **Stop** in the right-click menu, the dropdown, and Shift+Enter. A restart
asks **once**, for the restart, rather than once for the stop and again for the start.

What it deliberately does not cover is the actions that are already about more than this row:
**Stop All Running Tasks**, **Restart All Running Tasks**, and the stop and restart on a package
heading. Those are the deliberate gesture the flag exists to make you perform, and a dialog per row
there would turn one decision into ten.

The flag is a task at a time, and only tasks — a package heading runs nothing itself, and a task
under OTHER TASKS belongs to whoever started it. [Compose files](#docker-compose) are out as well,
and for a reason of their own: one is a single item in the tree rather than a folder of rows, so
there would be nowhere to put the toggle and no way back off once it was on. ▶ and ■ on a stack are
already the deliberate gesture the flag is for. A flag an older version left on a compose row is
dropped the next time the workspace is scanned, rather than asking with no switch to answer it with.
[The menu](#the-menu) clears the lot with **Reset all confirmations**.

### Reordering rows

Drag a row in the tree to put it where you want it. A manifest lists its tasks in whatever order they
were written in, which is rarely the order you use them in — so `dev` can sit at the top of its
package even if it is the eleventh script in the `package.json`.

Dropping on a group heading sends the row to the end of that group. The starred rows at the top are a
list of their own and reorder the same way.

**Dropping a task on a starred row stars it too**, in the slot it lands on — the same thing clicking
☆ does, so the task keeps the place it has in its own package. It is an addition, not a move. With
nothing starred yet there is no row to aim at; ☆ on the row itself is always there.

Every other cross-group drop does nothing: the tree's groups are the manifests on disk, and no
gesture in a sidebar moves a script from one `package.json` to another. VS Code owns the drop cursor
and the row highlight and gives an extension no say in either — `handleDrop` is only called once the
drop has already happened, so a forbidden row cannot be greyed out under the mouse. Instead the
status bar says where the row can go while it is in the air, and why nothing moved when it lands
somewhere it cannot go.

The order lives in the workspace's own storage, next to the stars and the renames — the manifests
themselves are never rewritten, so nothing shows up in `git status` and nobody else on the team
inherits your ordering. A task added to the manifest later keeps the neighbour it has there, sorting
in right below the row it follows in the file rather than appearing at the bottom of a list you
arranged months ago. **Reset sort order** in [the menu](#the-menu) puts everything back.

With `pinRunningTasks` on, what a drag saves is still the order underneath the pin: dropping a row on
another one records that they belong next to each other, and once nothing is running that is where
they are. Saving what was on screen instead would freeze one task's run into the store and leave the
list scrambled the moment it stopped.

### Renaming a row

Right-click a script → **Rename…** to call it whatever you actually call it. `dev` becomes
`API server`, and the row keeps the real script name in the dimmed text beside it, so you can still
see what runs:

```
▶ API server    dev · vite dev
```

The name in the manifest is never touched — this is a label on your side of the screen, not an edit
to the project's `package.json`. The renamed script stays findable by its real name in the dropdown,
which matches on that dimmed text too. Clear the input box to get the original name back.

The rename follows the script everywhere it is listed: the dropdown, the starred row at the top and
its own package group all show the new title. The task terminal keeps the real name, since that is the one
the package manager is given.

#### Renaming a group heading

The same **Rename…** on a group heading renames the package instead. A scoped name in a deep
monorepo spends the row on saying where it is twice over, and a title of your own stands in for
everything before the bullet:

```
@acme/api-gateway • packages/services/api-gateway
Gateway • packages/services/api-gateway
```

It is the same kind of label as a renamed script: the `package.json` keeps its `name`, the folder
keeps its name on disk, nothing lands in `git status`. What the heading loses, the row keeps
elsewhere — the path after the bullet still says where the group is, and the tooltip still carries the
name the manifest gives it. That is the one difference from a script row, which shows its real name
in the dimmed text beside the label: a heading is tinted whole, description included, so the real
name lives in the tooltip rather than on the row.

The new title is used wherever the group is named — the tree heading, the dropdown's separator, the
package a starred row says it came from, and the status-bar message while a row is being dragged.
A title typed by hand is shown exactly as it was typed, like everything else on the row.

**OTHER TASKS** and **hidden** cannot be renamed — they are this extension's own labels, not names
read off a manifest, so there is nothing to restore them to.

Both kinds of title live in the same store, so **Reset all titles** in [the menu](#the-menu) undoes
scripts and headings together.

### Painting a row

Right-click any row → **Change Colour…**, and pick one of fifteen: red, orange, yellow, lime, green,
teal, cyan, blue, indigo, purple, magenta, pink, brown, slate or grey. Every task takes one, and so
does every folder in the tree — package headings and OTHER TASKS alike. Each entry is drawn with its
own filled circle, so the list is picked from by eye rather than read.

The row takes the colour immediately — the icon, the label and the dimmed text beside it, which keeps
the opacity it always had — so a painted row reads as one thing rather than a tinted dot beside grey
text. The one exception is a row wearing an icon from your icon pack: that icon is the pack's own
artwork and carries no colour, so the paint lands on the label and leaves the icon as it is.

What it is for is the thing a category cannot know. The icons already say what a task *is* — a beaker
for tests, a rocket for a release — and they say it the same way in every project. A colour says what
this task is to *you*: the deploy nobody may run by accident in red, the one service you actually
work on in green, the four packages you never touch in grey. A heading painted the same colour as the
rows you care about inside it turns a long sidebar into something you scan rather than read.

The colours are picked to hold up in both themes: each is declared as a real theme colour with a
light, a dark and two high-contrast variants, so a painted row stays legible when the theme changes
under it. They can be overridden like any other, in `workbench.colorCustomizations`, under
`taskRunnerUltimate.palette.red` and its nine siblings.

**Default**, the first row of the same list, takes the colour back off. A task then returns to its category's
colour — the green ▶, the red beaker — and a heading to the shared title colour every other heading
wears.

Three things a colour deliberately does not do:

- It does not survive a run. A running row shows the same green spinner it always has, painted or
  not: while a task is alive, "this one is busy" is the one thing the icon is being asked, and it has
  to answer it the same way on every row.
- It does not follow the row into the dropdown. VS Code drops colours from quick-pick items, so the
  dropdown keeps the glyph and loses the tint — there is no API to keep it.
- It does not turn off with `colorIcons`. That setting drops the colours *we* guessed at from the
  task's name; a colour you picked by hand is not a guess, so it stays.

Painting a folder paints that row only — the tasks under it keep whatever they have. Like the
titles, colours are stored per workspace against the same refs, so **Reset all colours** in
[the menu](#the-menu) clears tasks and folders together.

This is the one thing **OTHER TASKS** can have that a rename is not: a rename needs a
name on disk to put back and that one is a label of this extension's own, while a colour needs
nothing but a row to sit on. The only rows without it are the tasks under **OTHER TASKS** — they are
somebody else's executions, alive only while they run, so there is nothing stable to remember a
colour against.

The palette is a list rather than a flyout because of what a flyout cannot draw. A context menu
carries no icons at all — VS Code hands those menus to the platform, which has no place to put one —
so while the colours lived there the only swatch that survived was one spelled as a character in the
label, and Unicode has no coloured circle for teal, pink, grey or any of the five the palette gained.
A quick pick draws a real image, so all fifteen are the same circle in fifteen colours.

The swatches are files the extension ships rather than the theme colours themselves, because VS Code
turns a `ThemeIcon` into a bare codicon on the way into a quick pick and drops its colour doing it —
only image icons are drawn in colour there. One consequence is worth knowing: a palette colour
overridden in `workbench.colorCustomizations` is painted on the row as your override and drawn in the
list as the shade the extension ships. A high contrast theme is the same story — the row takes the
high contrast shade, the swatch stays the ordinary one.

### Changing a row's icon

Right-click any row → **Change Icon…**. The list is in two halves.

The top half is **whatever file icon theme you are running** — Material Icon Theme, vscode-icons, or
whichever pack you installed — listed by name with its own artwork beside each entry, so the icons
are picked by eye. Typing filters on the name beside them as well, which is usually the faster half
to type: `*.rs`, `Dockerfile`, `src/`.

The bottom half is the icon font VS Code ships with, in five sections — actions and status, objects,
dev and infrastructure, files and folders, git and people.

Both halves are offered on every row: tasks, package headings, compose files and script folders
alike. **Default** at the top takes it back off, and the row returns to the icon its category or its
kind gives it.

An icon picked out of a pack is stored as *the name that reaches it* — `Dockerfile`, `src`, a file
ending — and never as anything belonging to the pack itself. Three things follow from that, and they
are the reason it is done that way:

- **Switching packs keeps your choice.** Material Icon Theme and vscode-icons disagree about
  everything except what a Dockerfile is, so a row marked with the Docker icon shows each pack's own
  Docker icon, and changes the moment you change the pack.
- **It works with packs that have no image files.** Seti, the one VS Code ships with, draws from a
  font. Those icons have no picture to preview, so they are listed without one — and they still draw
  on the row exactly like any other.
- **Light and dark follow the pack.** The workbench resolves the icon, so a pack with two variants
  switches with the theme on its own.

A pack the workbench has no rule for — an icon whose pack you uninstalled — falls back to that pack's
plain file icon rather than to an empty square.

The running spinner still wins over any icon, picked or not: while a task is alive, "this one is
busy" is the one thing the icon is being asked.

### Reaching the row commands

**Run**, **Stop**, **Add to Favorites**, **Remove from Favorites**, **Enable Confirmation**,
**Disable Confirmation**, **Go to Script Definition**, **Open Manifest File**, **Show Terminal**,
**Add to Terminal**, **Copy Relative Path**, **Copy Path**, **Reveal in Finder**, **Reveal in
Explorer View**, **Rename…** and **Colour** all act on the row they were invoked from, so they
live where there is a row to invoke them on:

| Command | Where |
| --- | --- |
| Run (Click) | a click on an idle row, and right-click — the label names the gesture, since a mouse has no keybinding to show there |
| Stop (Double-Click) | a double click on a running row, and right-click; ■ inline on hover stops on one press |
| Add to Favorites | ☆ inline on hover, and right-click |
| Remove from Favorites | ★ inline on hover, and right-click |
| Enable Confirmation | right-click only, on a script row — one half of a toggle, shown while the row starts and stops straight away. Never on a [compose item](#docker-compose), which does not ask |
| Disable Confirmation | right-click only, on a script row — the other half, shown while the row [asks first](#asking-before-a-task-starts-or-stops) |
| Go to Script Definition | right-click only, on a script row — a row already carries up to three hover buttons, and a fourth would push the ones pressed all day away from the label |
| Open Manifest File | right-click only, on a package heading — the same action one level up, opening the file the heading names at the top; OTHER TASKS names no file and does not offer it |
| Show Terminal | a click on a running row, and right-click — ours and the ones under OTHER TASKS alike. It is the way back from a task started with ▶, which leaves the panel where it was |
| Compose Up | ▶ inline on hover and right-click, on a [compose item](#docker-compose) only — the file's own bare `up`. Not offered while one of ours is already running it, and not on a row sitting in the hidden pile |
| Compose Down | ■ inline on hover and right-click, on a compose item — it ends whatever of ours the file has running and then runs `docker compose down`, and does neither if something refuses to stop |
| Compose Commands… | right-click only, on a compose item — the picker holding one `up` per declared service and the extra subcommands from [`dockerComposeCommands`](#settings) |
| Add to Terminal | right-click only, on a [shell row](#shell-scripts) — a new terminal with the command line typed into it and not run, which is where a script takes arguments nobody wrote down. A manifest task says its own arguments in the manifest, so the entry is not offered there |
| Copy Relative Path | right-click only, on the rows that are a file or a folder — a heading's manifest, the directory a [shell group](#shell-scripts) stands for, or a shell row's own script. Relative to the workspace root, and named with its folder when more than one is open; a folder that *is* the root copies its own name, which is the one path there is nothing to cut off. The rows that name no file — FAVORITES, OTHER TASKS, an ecosystem parent and the aggregated `shell [N]` heading — do not offer any of the four |
| Copy Path | the same rows, the whole path. A manifest task is not one of them: an npm script is a line in a file its siblings share, so every row of the group would copy the same `package.json` |
| Reveal in Finder | the same rows, in the platform's file manager — **Reveal in File Explorer** on Windows, **Open Containing Folder** on Linux, since the workbench calls it something different on each. Not offered over a remote connection, where the file is on the other machine and the workbench opens nothing; WSL is the exception it makes, and the one remote that keeps the entry |
| Reveal in Explorer View | the same rows, in VS Code's own Explorer side bar rather than the desktop's — which is why this one is offered in a remote window too |
| Rename… | right-click only, on a script row and on a package heading alike — a rename is rare enough not to earn a permanent button |
| Change Colour… | right-click only, on every row the tree draws itself — one entry opening a list of fifteen, so the palette costs the menu one line rather than fifteen |

All of them are deliberately hidden from the command palette, which has no row to hand them. The
palette keeps the eight that stand on their own: **Show Scripts**, **Menu**, **Refresh Scripts**,
**Check Containers**, **Stop All Running Tasks**, **Restart All Running Tasks**, and the two halves of
the grouping switch — **Group by Ecosystem** and **Show as a Flat List**, each of which sets a mode
rather than toggling one, so invoking the one you are already in changes nothing.

### Where list customizations are stored

In VS Code's own workspace storage (`ExtensionContext.workspaceState`) — not in your `package.json`,
and not in `.vscode/settings.json`. Titles, colours, icons, task and package order, favorites,
confirmations, hidden packages and folded groups have separate stores. That storage is already scoped to this extension
and this workspace, so no key can collide with anything and none of them show up in a diff.
[The menu](#the-menu) can empty each user-facing customization separately or clear all of them.

Starring a script is a personal note about a file the project owns, so the alternatives both have a
cost: the manifest is shared with everyone who clones the repo, and a setting would rewrite
`settings.json` on every click. Workspace storage keeps it out of both, at the price of it being
per-workspace and per-machine — a second computer starts with nothing starred.

Scripts are matched back by the workspace folder's name plus the manifest path inside it plus the
script name — `my-app/packages/api/package.json::dev` — rather than by absolute path. Moving the
whole project somewhere else on disk therefore keeps every star and every title; *renaming* the
folder does not.

A renamed heading is keyed by the same string without the `::name` half —
`my-app/packages/api/package.json` — which is also the scope a drag reorders inside. Since no
manifest path ends in `::` plus a name, headings and scripts share the `titles` key without any
chance of one shadowing the other. Colours are filed under those same two kinds of ref, in a store of
their own, and hold the colour's name — `green` — rather than the theme colour id behind it.

A favorite whose manifest is temporarily out of the workspace is hidden, not forgotten: it stays in
storage and comes back with its folder.

Deleting the script for real is the other case, and it is cleaned up. After every scan, each stored
title, colour, icon, star, confirmation and drag position is checked against the manifest it names,
and the ones whose manifest was just read *without* that task in it are dropped. So a `deploy` script
taken out of a `package.json` takes its star and its colour with it, and does not silently reattach
them to a future script that happens to take the name back.

The check is narrow on purpose: a ref goes only when its own manifest was part of that scan. "The
file is not here right now" is not "the task is gone", so a closed workspace folder, an ecosystem
switched off in `taskRunnerUltimate.sources`, and a scan cut short at the manifest cap all keep
everything they had. Hidden packages, folded groups and the order of the headings are keyed by a
manifest rather than by a task, and are never touched by this — a manifest losing a script says
nothing about whether the manifest is still there.

An [ecosystem row](#grouping-by-ecosystem) has no manifest at all, so its fold, its colour and its
icon are filed under a constant of ours — `group:eco:rust` — exactly as **OTHER TASKS**, the
**Favorites** folder and the hidden pile are. Nothing about it can go stale, and the prune above never looks at it: it names no
task, so there is no task whose disappearance could take it away. The ecosystems themselves are
ordered by where their first package sits in the one saved order the headings already have, so
dragging a whole ecosystem and dragging one package inside it write the same store.

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
manifest — the manifests in the order the tree has them, and inside a block the order the tree
shows, drags and all. With [grouping by ecosystem](#grouping-by-ecosystem) on, the blocks arrive
gathered into runs and the first separator of each run carries its name — `Node · web —
apps/web/package.json`, then the rest of the Node blocks unprefixed. Repeating it on every separator
would be the noise the tree already avoids. On a workspace with a single manifest and nothing starred the headings
are dropped entirely, since the only one there would be repeating the picker's own title.

| Action | Effect |
| --- | --- |
| `Enter` on a stopped script | Starts it and closes the picker, so the task terminal is visible. |
| `Enter` on a running task | Stops it; the picker stays open and refreshes in place. |
| `Shift+Enter` | Restarts the focused entry (starts it if it was stopped). The picker stays open, so the terminal is not brought up underneath it. |
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

Press `Cmd+K Cmd+S` (`Ctrl+K Ctrl+S`), search for **Task & Script Explorer: Show Scripts** and click the
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
`.vscode/settings.json`, so a repository can pin its own runner for everyone who opens it. Three
exceptions, and they are deliberate: `dockerCompose`, `shellRunner` and `shellRunners` are
machine-scoped, because each of those values is the name of a program this extension executes rather
than text typed into a task terminal — and a program name is not something a repository you cloned
gets to choose for the machine that opens it. Those three are set in your own settings.

| Setting | Default | What it does |
| --- | --- | --- |
| `title` | `Task & Script Explorer` | The heading over the list — in the activity bar view and in the File Explorer section alike. 1 to 100 characters; left empty it goes back to the default. See [Renaming the heading](#renaming-the-heading). |
| `sources` | all eleven | Which ecosystems are scanned: `node`, `rust`, `python`, `make`, `just`, `task`, `go`, `php`, `mise`, `docker`, `shell`. A removed one is never read. |
| `packageManager` | `auto` | Forces `npm`, `yarn`, `pnpm`, `bun` or `deno` instead of [detecting it](#runner-detection). Node only: `deno.json(c)` ignores it, and no other ecosystem is affected. |
| `cargoCommands` | `run`, `build`, `test`, `clippy`, `fmt` | The cargo subcommands every crate gets — see [Rust](#rust). |
| `goCommands` | `run`, `build`, `test`, `vet` | The go subcommands every module gets. |
| `pythonRunner` | `auto` | How `[project.scripts]` entry points are entered — see [Python](#python). `none` hides them. |
| `dockerCompose` | `docker compose` | The compose command — the v2 plugin, or the standalone `docker-compose`. See [Docker Compose](#docker-compose). |
| `dockerComposeCommands` | `build`, `logs`, `ps` | The **extra** compose subcommands, offered from a compose item's **Compose Commands…** picker. `up` and `down` are the item's two buttons and are not listed here; the picker also carries one `up` per declared service. |
| `dockerfileCommands` | `run` | The **extra** Docker actions listed for every Dockerfile. `build` is always listed and is not named here; a `build` row is also listed per named `FROM … AS <stage>`. |
| `shellScripts` | `**/scripts/**/*.{sh,bash,zsh,ksh,ps1,bat,cmd}`, the same under `**/bin/**/`, and the bare `*.{sh,…}` | Where [shell scripts](#shell-scripts) are looked for, as globs matched against each file's path relative to its workspace folder. |
| `shellRunner` | `bash` | What a Bourne-family shell row — `.sh`, `.bash`, `.zsh`, `.ksh` — is run through. Empty runs the path on its own. |
| `shellRunners` | `powershell -NoProfile -File` for `.ps1`, nothing for `.bat` and `.cmd` | What each extension is run through, keyed by extension. One that is not named here falls back to `shellRunner`. |
| `exclude` | `**/{node_modules,.git,dist,out,build,.next,coverage,target,vendor,__pycache__,.venv,venv,.tox,.nox,.mypy_cache,.pytest_cache}/**` | Glob of manifests to skip while scanning. Widen it in a large monorepo. |
| `showInEditorTitle` | `true` | The ▶ icon in the editor title bar. |
| `showInStatusBar` | `true` | The `Tasks` entry (and its Restart all / Stop all buttons) in the status bar. |
| `showInFileExplorer` | `true` | The `Task & Script Explorer` section at the foot of the File Explorer. It ships collapsed, so it takes one header row until you open it. |
| `openDropdownFromActivityBar` | `false` | Also opens the dropdown whenever the activity bar view is revealed. Off because the view already shows the same list as a tree. |
| `colorIcons` | `true` | Tints task icons by category. Turn off for plain foreground-coloured icons. |
| `pinRunningTasks` | `false` | Lifts running tasks to the top of their own group, in the tree and the dropdown. Off because a row that stays put is a row you stop where you started it. |
| `grouping` | `flat` | `flat` keeps one row per manifest and folds compose files and script folders [inside the project they serve](#what-a-project-takes-in-with-it); `ecosystem` gathers the headings under [a row per ecosystem](#grouping-by-ecosystem) instead. |
| `groupIcons` | `type` | `type` gives each heading the icon its own file has in your file icon theme; `uniform` gives every heading the same stack glyph. Neither colours anything — painting a heading is [yours to do](#painting-a-row). |
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
`charts.green`. The built-in categories are run, test, quality, build, release, data, clean and stop,
and each has a `taskRunnerUltimate.category.<name>` colour you can override in
`workbench.colorCustomizations`.

`up` and `down` are the one pair spelled out on their own: a filled ▶ in the run green for the row
that brings a stack up, a hollow ■ in red for the one that takes it down — the same solid-versus-hollow
pair the row's own buttons use. `stop`, `kill`, `teardown` and `destroy` read as `down` does.

## Behaviour

- Scans every manifest in [the table above](#what-gets-scanned), skipping `node_modules`, `target`,
  `.venv`, `vendor`, `dist`, `out`, `build`, `.next`, `coverage` and the rest (configurable via
  `taskRunnerUltimate.exclude`). `deno.jsonc` comments and trailing commas are tolerated, and both the
  string and the Deno 2 object task form (`{ "command": …, "description": … }`) are read.
- TOML, INI, Makefile, justfile, Taskfile and compose parsing is done in-extension: the extension ships with
  no runtime dependencies, and a manifest that cannot be parsed is skipped rather than reported —
  the file belongs to the project, and a scan that threw would take the whole list down with it.
- Make skips pattern rules (`%.o:`), targets built out of a variable (`$(BIN):`) and the special
  ones (`.PHONY`); `just` skips `_`-prefixed and `[private]` recipes; go-task skips `internal: true`;
  cargo-make skips `private` and `disabled`; Composer skips its event hooks. Compose reads its
  `services:` block by indentation, which is enough for the names and stops short of YAML anchors,
  multi-document files and flow style.
- In a monorepo the idle list is grouped per manifest, showing the package name and relative path —
  or [per ecosystem](#grouping-by-ecosystem), with the manifests one level down.
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
`sources`, `exclude`, `cargoCommands`, `goCommands`, `pythonRunner` — does the same, and so does one
that decides how a row is *launched* when the answer is written into the row at scan time rather than
worked out when it starts: `dockerCompose`, `dockerComposeCommands`, `dockerfileCommands`,
`shellScripts`, `shellRunner` and `shellRunners`.

File events arrive in runs — a branch switch, an `npm install`, a `cargo new` — so a rescan waits
for the run to stop rather than starting one per event and abandoning it on the next. **Refresh** and
a change to one of the settings above skip that wait: neither comes in a burst, and both are somebody
waiting for an answer.

Some rows are not written down in any manifest, and those files count too: a crate offers `run`
because it has a `src/main.rs`, a `run: <name>` for every binary under `src/bin`, an
`example: <name>` for every example under `examples`, and a Go module offers `run` when its applicable
root `.go` files form `package main` and declare `func main()` — in `main.go` or any other root file.
Creating, deleting, or editing one of those refreshes the list because its contents decide whether
the row can run.

Detected runners are dropped along with it. That matters because `packageManager` and `engines` live
in the very file being edited: switching a package from npm to pnpm has to change how its scripts
are launched, not just what the list says. The cost is a rescan plus a few stat calls per package,
on a change you made yourself.

`Task & Script Explorer: Refresh Scripts` does exactly the same thing on demand, for the cases no
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

The count of running tasks is shown on the activity bar and File Explorer views through a real API
(`TreeView.badge`), and in the status bar entry. The editor title icon carries no badge: title-bar
icons are static images with no way to draw on them. The running count is still published into the
`taskRunnerUltimate.runningCount` context key, which is what the view header's Stop all / Restart all
buttons appear on. The icons and the menu entries are generated:

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
