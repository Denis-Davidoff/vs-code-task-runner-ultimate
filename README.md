# ▶ AI Task & Script Explorer

**Every script in your workspace, and everything currently running, in one list. Start, stop and
restart without ever going looking for a terminal tab.**

![AI Task & Script Explorer in action](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-task-runner-ultimate/main/promo-video.gif)

## Extension Features

- ✨ **[AI tasks — new](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#ai-tasks)** — a prompt for **Claude Code**, **Codex** or **GitHub Copilot**,
  kept as a row and run with a click: *review the uncommitted changes*, *write the release notes*,
  *find what breaks the build*. Or for any **OpenAI-compatible API** — OpenAI, OpenRouter, or a
  **local model** in Ollama or LM Studio, where nothing leaves your machine — or for any other command
  line. Put context in the prompt with `${gitDiff}`, `${selection}`, `${file}` and more. Pick the
  access an agent runs with — **read-only**, **edit files** or **full** — and where the answer goes: a
  Markdown report, the clipboard, a notification. The **+** at the head of the panel → **AI Task**
  makes one. A prompt that changed behind your back — a teammate's commit, a hand edit — asks once
  before it runs, and says what changed.
- 🔁 **[Folders and workflows — new](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#folders-and-workflows)** — lists of your own made out of
  any tasks the workspace has. A **folder** starts everything in it at once — the whole dev stack in
  one click. A **workflow** runs its steps one after another and stops at the first that fails:
  *lint → test → AI review → build*. Drag tasks onto them, and commit them with the project.
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
- 🖼️ **[Any icon your icon pack has](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#changing-a-rows-icon)** — right-click → **Change Icon…**: the icons VS Code
  ships with first, then every icon of whichever file icon theme you run — Material Icon Theme,
  vscode-icons — each drawn in the list with its own artwork. Picked by name, so switching packs
  keeps your choice.
- ⭐ **[Favorites](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#favorites)** — star the two or three scripts you actually run and they sit as
  loose rows at the very top of the tree, above everything, with no heading to open first and
  without leaving the package they belong to. A compose file or a Dockerfile can be starred too, and
  comes up there with its ▶ and ■.
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
  opening it — a click on the heading brings it up too — and the heading spins while any part of it runs. **Check Containers** asks Docker what
  is really up — including stacks you started from a terminal or with `up -d` — and ■ then stops
  them.
- 🏗️ **[Dockerfiles, as one row each](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#dockerfiles)** — every `Dockerfile`, `Dockerfile.dev` and
  `api.Dockerfile` in the workspace. **▶ or a click on the file's own row builds it** and ☰ beside it holds the
  rest — one build per `FROM … AS <stage>`, plus `run` and whatever else `dockerfileCommands` names —
  so a file is a line rather than a folder, and the row spins while a build runs. The image is tagged
  after the folder it sits in, so a build leaves something you can run rather than a dangling id.
- 💻 **[Shell scripts, as tasks](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#shell-scripts)** — `.sh`, `.bash`, `.zsh` and `.ksh`, and on Windows
  `.ps1`, `.bat` and `.cmd`, picked up from `scripts/`, `bin/` and the workspace root at any depth.
  Each project's scripts gather under one `shell` folder with a terminal icon, a row no category
  claimed wears the shell it is read by, the dimmed text is the script's own first comment, and each
  extension is started by the runner that can start it. **Add to Terminal** puts the command line in a fresh
  terminal unrun, for when a script takes arguments, and **Copy Command** — on every script row that
  runs a command line, not only these, and on compose files and Dockerfiles — puts it on the clipboard.
- ✍️ **[Custom tasks](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#custom-tasks)** — a name and a shell command of your own,
  `docker compose down -v && docker compose up -d db` included, under **Shell scripts** at
  the top of the tree, with AI tasks in a separate **AI tasks** folder. ⋮ → **Create custom task** makes the first, the heading's **+** the rest. Kept in
  `.vscode/task-script-explorer.json`: commit it for the team, or keep it to yourself.
- 🧠 **[Knows how to run things](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#runner-detection)** — npm, yarn, pnpm, bun or deno detected per
  package from `packageManager`, the lock files and `engines`; everything else named by the table it
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
*and* the tool right first. AI Task & Script Explorer collapses all of that into one list, and gives you
three ways to reach it.

**[Full documentation](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md)** —
what gets scanned, how each ecosystem is run, every row, button and setting explained.

Visual Studio Code Marketplace link: https://marketplace.visualstudio.com/items?itemName=DenysDavydov.task-runner-ultimate

Open VSX Registry link: https://open-vsx.org/extension/DenysDavydov/task-runner-ultimate

## Try another useful extension: AI Browser🏆 Claude + Codex.
Visual Studio Code Marketplace link: https://marketplace.visualstudio.com/items?itemName=DenysDavydov.tab-browser-ultimate-promo

Open VSX Registry link: https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate

## Change log 0.9

- 0.9.10: [AI tasks](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#ai-tasks) can now run on **GitHub Copilot's CLI**, held to read-only, edit files or full access like Claude Code and Codex; on any **OpenAI-compatible API** — OpenAI, OpenRouter, DeepSeek, Groq, or a local Ollama or LM Studio — set up once per machine with **AI providers** in the ⋮ menu, its key kept in VS Code's secret storage; or on **any other command line** you name, which is given the prompt on its input and runs with full access. Prompts can take [context](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#context-in-the-prompt) as they run: `${gitDiff}`, `${gitDiffStaged}`, `${gitLog}`, `${selection}`, `${file}`, `${filePath}` and `${clipboard}`. A task whose API provider is not set up on this machine, or whose key is turned away, offers to set it up or pick another.

- 0.9.9: New [folders and workflows](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#folders-and-workflows), made from the **+** at the head of the panel. Put any tasks of the workspace in one — package scripts, make targets, compose services, custom and AI tasks — by dragging them onto it, with **Add to Folder…** on a row, or with **Add Tasks…** on the folder. ▶ on a folder starts everything in it at once; ▶ on a workflow runs its steps one after another, marks each ✓ as it passes, and stops at the first that fails, offering to run again from that step. Both are kept in `.vscode/task-script-explorer.json`, and one that changed outside the tree asks once before it runs, showing its whole list; a change you make in the tree keeps an approved list approved but never approves one that came from somewhere else. A workflow whose list changes while it runs stops before its next step, ■ stops it before the next step starts, a second ▶ while it is starting is ignored rather than starting it twice, and **Run Again from Step N** finds the step that failed even if the list has changed since. Scripts in the root of the project are saved without the folder name, so a workflow works in every clone. The extension is now called **AI Task & Script Explorer** — its commands in the palette, its settings and its messages carry the new name; the view in the activity bar is still **Task & Script Explorer**.

- 0.9.8: New [AI tasks](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#ai-tasks): a prompt for Claude Code or Codex, kept under **Custom Tasks** and run headless with the access you choose — read-only, edit files, or full. Press the new **+** at the head of the panel and pick **AI Task** — or **Shell Task** for a command line of your own. The answer opens as a Markdown report, goes to the clipboard or shows in a notification, and the agent's progress streams into the task's terminal, where ■ or Ctrl+C stops it. An AI task that reached the file some other way asks once before it runs, and again whenever its prompt, agent or access changes. Approvals of custom tasks and AI tasks alike are now signed with a key kept in VS Code's secret storage, so they cannot be forged by writing into workspace storage. A task whose agent is not installed on this machine, or whose model is not available here, offers to pick the agent and model again and run. New setting `taskRunnerUltimate.aiAgentPaths` for agents installed somewhere they are not found on their own.

- 0.9.7: A click on a [compose file](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#docker-compose) or a [Dockerfile](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#dockerfiles) row now runs it, `docker compose up` or `docker build`, and brings up its terminal; once something of the file's is running, the click goes to that terminal instead. New **Copy Command** in the right-click menu of every script row, compose file and Dockerfile puts the command line it runs on the clipboard, quoted for your shell. A compose file or a Dockerfile can be added to [Favorites](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#favorites) with ☆ on its row or from the right-click menu, and shows up there as the file itself, ▶, ■ and click included. **Add to Terminal** and **Copy Command** quote for fish as well, and refuse a line holding a control character, or one that needs quoting in a shell they do not know how to quote for.

- 0.9.6: Bug fixes

- 0.9.5: Git worktrees that coding agents check out inside the repository, such as Claude Code's `.claude/worktrees/`, no longer show up as extra copies of every task. Manifests and scripts that git ignores, through `.gitignore`, `.git/info/exclude` or your global excludes file, are [left out of the list](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#what-git-ignores). Set `taskRunnerUltimate.respectGitignore` to `false` to list them again.

- 0.9.4: Stop all and restart all buttons on more headings: the [Favorites](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#favorites) folder in ecosystem mode, the hidden pile and OTHER TASKS. Hover a heading while something under it runs to see ■ and ⟳.

- 0.9.3: **Go to Script Definition** is more precise: a duplicated JSON key goes to the occurrence that counts, quoted TOML keys are found, and a short script name is selected as the key rather than inside a longer word. Typographic quotes in a command are kept from breaking PowerShell, Go projects are rescanned less often, and signed hex, octal and binary numbers in TOML are kept as text.

- 0.9.2: Bug fixes

- 0.9.1: Bug fixes

- 0.9.0: Added [custom tasks](https://github.com/Denis-Davidoff/vs-code-task-runner-ultimate/blob/main/docs/MANUAL.md#custom-tasks): open the ⋮ menu in the panel header and pick **+ Create custom task**.