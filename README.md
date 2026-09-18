# ▶ Task & Script Explorer

**Every script in your workspace, and everything currently running, in one list. Start, stop and
restart without ever going looking for a terminal tab.**

![Task & Script Explorer in action](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-task-runner-ultimate/main/promo-video.gif)

- 📋 **[A panel in the left bar](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#the-task--script-explorer-view)** — every task of the workspace as a
  tree, grouped by the manifest it came from. Nothing moves when a task starts, and the number of
  running tasks rides on the activity bar icon as a real VS Code badge.
- ⚡ **[A button in every editor's toolbar](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#-in-the-toolbar-of-every-file)** — the ▶ icon, so the
  whole list is one click away from wherever you happen to be.
- ⌨️ **[A hotkey, from anywhere](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#keyboard-shortcuts)** — <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>T</kbd>
  (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> on Windows and Linux) opens the whole list without
  touching the mouse, from the editor, the terminal, anywhere.
- 🔍 **Search that matches the command too** — type `vitest` and find the script that runs it, not
  just the ones called "test". <kbd>Enter</kbd> toggles a task, <kbd>Shift</kbd>+<kbd>Enter</kbd>
  restarts it.
- ✏️ **[Rename any row, and any heading](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#renaming-a-row)** — `dev` becomes `API server`, and the
  group titled `@acme/api-gateway` becomes `Gateway`. Display only: the project's
  manifest is never edited, and the real name stays visible beside it and searchable.
- 🖍️ **[Paint a row](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#painting-a-row)** — right-click → **Change Colour…** → one of fifteen, on a task
  or on a whole folder, each drawn as a circle in its own colour. The list stops being one colour of
  text and starts being a map of what is yours, what is loud and what you never touch.
- 🖼️ **[Any icon your icon pack has](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#changing-a-rows-icon)** — right-click → **Change Icon…**, and the list
  opens with the icons of whichever file icon theme you run — Material Icon Theme, vscode-icons —
  drawn in the list, beside the ones VS Code ships with. Picked by name, so switching packs keeps
  your choice.
- ⭐ **[Favorites](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#favorites)** — star the two or three scripts you actually run and they sit as
  loose rows at the very top of the tree, above everything, with no heading to open first and
  without leaving the package they belong to.
- ↕️ **[Drag rows into the order you want](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#reordering-rows)** — inside a package, or among the
  starred rows. The order is remembered per workspace and the manifests are never edited.
- 🎨 **Colour and an icon per task** — ▶ for dev servers, a beaker for tests, a rocket for releases,
  a database for migrations, decided by what the task really runs — and [your own rules](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#settings)
  come first.
- 🧩 **[Eleven ecosystems, one list](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#what-gets-scanned)** — `package.json`, `deno.json`, `Cargo.toml`,
  `Makefile.toml`, `pyproject.toml`, `Pipfile`, `tox.ini`, `noxfile.py`, `Makefile`, `justfile`,
  `Taskfile.yml`, `go.mod`, `composer.json`, `mise.toml`, `docker-compose.yml`, `Dockerfile` and the
  shell scripts every repository accumulates, so a mixed monorepo is still one list.
- 🐳 **[Docker Compose, as rows](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#docker-compose)** — every compose file in the workspace, including
  the profile-named ones, with `up` fanned out per service and `down`, `build`, `logs` and `ps`
  beside it. **▶ and ■ live on the file's own heading**, so a stack goes up and comes down without
  opening it, and the heading spins while any part of it runs. **Check Containers** asks Docker what
  is really up — including stacks you started from a terminal or with `up -d` — and ■ then stops
  them.
- 🏗️ **[Dockerfiles, as one row each](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#dockerfiles)** — every `Dockerfile`, `Dockerfile.dev` and
  `api.Dockerfile` in the workspace. **▶ on the file's own row builds it** and ☰ beside it holds the
  rest — one build per `FROM … AS <stage>`, plus `run` and whatever else `dockerfileCommands` names —
  so a file is a line rather than a folder, and the row spins while a build runs. The image is tagged
  after the folder it sits in, so a build leaves something you can run rather than a dangling id.
- 💻 **[Shell scripts, as tasks](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#shell-scripts)** — `.sh`, `.bash`, `.zsh` and `.ksh`, and on Windows
  `.ps1`, `.bat` and `.cmd`, picked up from `scripts/`, `bin/` and the workspace root at any depth.
  Each project's scripts gather under one `shell` folder with a terminal icon, a row no category
  claimed wears the shell it is read by, the dimmed text is the script's own first comment, and each
  extension is started by the runner that can start it. **Add to Terminal** puts the command line in a fresh
  terminal unrun, for when a script takes arguments.
- 🧠 **[Knows how to run things](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#runner-detection)** — npm, yarn, pnpm, bun or deno detected per
  package from `packageManager`, `engines` and the lock files; everything else named by the table it
  is declared in.
- ⏹ **Stop all / restart all** — kill five watchers before a rebase, or bring the whole stack back
  up after switching branches, in one click.
- 👀 **Running tasks this extension did not start** — from `tasks.json`, other extensions or the
  built-in npm list — are shown and can be stopped from the same place.

Tasks scatter. A monorepo buries them across a dozen `package.json` files, the Rust service next to
them keeps its own in a `Makefile.toml`, the Python one in `pyproject.toml`, and there is a
`justfile` at the root that half the team forgets exists. The stack everything talks to is a
`docker-compose.yml` two folders away, and the half-dozen `scripts/*.sh` nobody has opened since they
were written are how the release actually goes out. The dev server you started an hour ago is
alive in a tab you can no longer find, and running anything by hand means getting the directory
*and* the tool right first. Task & Script Explorer collapses all of that into one list, and gives you
three ways to reach it.

**[Full documentation](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md)** —
what gets scanned, how each ecosystem is run, every row, button and setting explained.

Visual Studio Code Marketplace link: https://marketplace.visualstudio.com/items?itemName=DenysDavydov.task-runner-ultimate

Open VSX Registry link: https://open-vsx.org/extension/DenysDavydov/task-runner-ultimate

## Try another useful extension: AI Browser🏆 Claude + Codex.
Visual Studio Code Marketplace link: https://marketplace.visualstudio.com/items?itemName=DenysDavydov.tab-browser-ultimate-promo

Open VSX Registry link: https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate