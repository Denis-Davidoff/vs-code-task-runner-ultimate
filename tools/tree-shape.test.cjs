const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The tree is built by module-private functions, so the extension is transpiled
// and run against a mock of its own rather than through the lifecycle harness's:
// that one deliberately fails `showWarningMessage` and stubs `startScript`, and
// widening it would make both files answer for the other's boundaries.
const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** A URI as much as the tree ever asks one to be: a path, and a stable name. */
function uri(at) {
  return {
    path: at,
    fsPath: at,
    scheme: 'file',
    toString: () => `file://${at}`,
    with: (change) => uri(change.path ?? at),
  };
}

function harness({ settings = {}, stored = {}, executions = [], scan = [], shell: shellPath = '/bin/zsh', pinned = {}, probeReply = () => ({ running: new Set(['web']) }) } = {}) {
  const probes = [];
  const launched = [];
  const terminals = [];
  const writes = [];
  const warnings = [];
  const hints = [];
  const vscode = {
    // The workbench's own answer for "what shell does a new terminal open in",
    // which is what decides how a typed command line is quoted.
    env: { shell: shellPath },
    window: {
      // Enough of a terminal to answer the two questions Add to Terminal asks of
      // one: where it opened, and what was typed into it without being run.
      showWarningMessage: (message) => (warnings.push(message), Promise.resolve(undefined)),
      // What a refused drop says, and the only place it says it.
      setStatusBarMessage: (message) => (hints.push(message), { dispose() {} }),
      createTerminal: (options) => {
        const terminal = { ...options, shown: 0, sent: [] };
        terminals.push(terminal);
        return {
          show: () => (terminal.shown += 1),
          sendText: (text, execute) => terminal.sent.push({ text, execute }),
        };
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (key in settings ? settings[key] : fallback),
        // `pinned` stands for the values a repository or a folder holds: what
        // `inspect` reports, and what a write cannot overrule.
        inspect: (key) => ({ globalValue: settings[key], workspaceValue: pinned[key] }),
        update: (key, value, target) => {
          writes.push({ key, value, target });
          if (!(key in pinned)) {
            settings[key] = value;
          }
          return Promise.resolve();
        },
      }),
      // No folder for anything, which conveniently makes every storage ref the
      // plain URI string and keeps the expectations below readable.
      getWorkspaceFolder: () => undefined,
      workspaceFolders: undefined,
    },
    commands: { executeCommand: async () => {} },
    tasks: {
      taskExecutions: executions,
      executeTask: async (task) => (launched.push(task), { task, terminate() {} }),
    },
    // Enough of a task to read back what was launched: the definition a row is
    // filed under, the name its terminal takes, and the words that actually run.
    Task: class {
      constructor(definition, scope, name, source, execution) {
        Object.assign(this, { definition, scope, name, source, execution });
      }
    },
    TaskScope: { Workspace: 1 },
    ConfigurationTarget: { Global: 'global', Workspace: 'workspace', WorkspaceFolder: 'folder' },
    ShellExecution: class {
      constructor(command, args, options) {
        Object.assign(this, { command, args, options });
      }
    },
    ProcessExecution: class {
      constructor(program, args, options) {
        Object.assign(this, { program, args, options });
      }
    },
    TaskRevealKind: { Always: 1, Never: 2 }, TaskPanelKind: { Dedicated: 1 },
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
    },
    ThemeIcon: Object.assign(
      class {
        constructor(id, color) {
          this.id = id;
          this.color = color;
        }
      },
      // The two VS Code resolves through the file icon theme, using resourceUri.
      { File: { themeFile: true }, Folder: { themeFolder: true } },
    ),
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    QuickPickItemKind: { Separator: -1 },
    Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }) },
  };

  const memento = {
    data: { ...stored },
    get(key) {
      return this.data[key];
    },
    update(key, value) {
      this.data[key] = value;
      return Promise.resolve();
    },
  };

  const context = vm.createContext({
    exports: {},
    process,
    setTimeout,
    clearTimeout,
    require: (name) =>
      name === 'vscode'
        ? vscode
        : name === 'path'
          ? path
          : name === './containers'
            ? { composeState: async (prefix, cwd) => (probes.push({ prefix, cwd }), probeReply()) }
            : // The tree reads one thing out of the scan module, and it is the one
            // that decides which parent row a heading lands under.
            name === './sources'
            ? {
                ecosystemOf: (kind) => ECOSYSTEMS[kind],
                ALL_ECOSYSTEMS: [...new Set(Object.values(ECOSYSTEMS))],
                collectScripts: async () => scan,
                emptyManifests: () => [],
                scriptKey: (manifest, task) => `${manifest}::${task}`,
                commandFor: (entry) => (entry.argv ?? [entry.name]).join(' '),
                launchArgv: (entry) => entry.argv ?? [entry.name],
                // The real test, verbatim: a stub that called everything plain
                // would leave the quoting below untested.
                plainArgument: (value) => /^[\w.:@/=+-]+$/.test(value),
              }
            : {},
  });

  vm.runInContext(
    compiled +
      `
    storage = memento;
    keyForTask = () => undefined;
    repaint = () => {};
    confirmScript = async () => true;
    exports.tree = { buildTreeRoots, buildItems, groupedByEcosystem, orderedByHost, dropGroups, savedOrder, hiddenRefs, treeItemFor, iconFor, addToTerminal, runGroup, stopStack, setGrouping, running, containers, checkContainers, recheckAfter, keyForTask, buildTask, stopContainers, SCAN_SETTINGS };
  `,
    Object.assign(context, { memento }),
  );
  return { ...context.exports.tree, memento, settings, probes, launched, terminals, writes, warnings, hints };
}

/** What the stubbed `ecosystemOf` answers — the same map the real one holds. */
const ECOSYSTEMS = {
  npm: 'node',
  cargo: 'rust',
  make: 'make',
  'docker-compose': 'docker',
  shell: 'shell',
};

function script(manifest, name, kind) {
  const directory = path.posix.dirname(manifest).replace(/^\/+/, '');
  return {
    key: `file://${manifest}::${name}`,
    name,
    command: name,
    manifest: uri(manifest),
    kind,
    cwd: uri(path.posix.dirname(manifest)),
    location: manifest.replace(/^\/+/, ''),
    directory,
  };
}

/**
 * A shell row as `collectShellScripts` builds one: the group is the directory,
 * and `file` is the script inside it.
 */
function shell(directory, name) {
  const location = directory.replace(/^\/+/, '') || path.posix.basename(directory);
  return {
    key: `file://${directory}::${name}`,
    name,
    command: name,
    manifest: uri(directory),
    file: uri(`${directory}/${name}`),
    kind: 'shell',
    cwd: uri('/repo'),
    location,
    directory: location.includes('/') ? location.slice(0, location.lastIndexOf('/')) : '',
  };
}

/**
 * The headings a set of roots names, top to bottom.
 *
 * The spread is load-bearing: everything the tree builds is constructed inside
 * the vm context, and `deepStrictEqual` compares prototypes — an array mapped
 * straight off one of those is never reference-equal to one written out here,
 * however identical it reads.
 */
const ids = (nodes) => [...nodes].map((node) => (node.kind === 'group' ? node.id : `script:${node.script.name}`));

/** The manifest each entry of an ordered list came from, in this realm's Array. */
const paths = (scripts) => [...scripts].map((entry) => entry.manifest.path);

const WEB = script('/repo/web/package.json', 'dev', 'npm');
const ENGINE = script('/repo/engine/Cargo.toml', 'build', 'cargo');
const API = script('/repo/api/package.json', 'start', 'npm');
const TOOLS = script('/repo/Makefile', 'all', 'make');

// --- the ordering pass -------------------------------------------------------

test('groupedByEcosystem gathers each ecosystem into one run, first appearance first', () => {
  const { groupedByEcosystem } = harness({ settings: { grouping: 'ecosystem' } });
  assert.deepEqual(paths(groupedByEcosystem([WEB, ENGINE, API])), [
    '/repo/web/package.json',
    '/repo/api/package.json',
    '/repo/engine/Cargo.toml',
  ]);
});

test('groupedByEcosystem keeps the order inside a run exactly as it was handed over', () => {
  const { groupedByEcosystem } = harness({ settings: { grouping: 'ecosystem' } });
  // `api` before `web` on the way in is `api` before `web` on the way out: the
  // drag order is decided by the pass before this one and must survive it.
  assert.deepEqual(paths(groupedByEcosystem([API, ENGINE, WEB])), [
    '/repo/api/package.json',
    '/repo/web/package.json',
    '/repo/engine/Cargo.toml',
  ]);
});

test('flat mode hands back the very list it was given', () => {
  const { groupedByEcosystem } = harness({ settings: { grouping: 'flat' } });
  const input = [WEB, ENGINE, API];
  // Reference equality on purpose: the default must not so much as copy the
  // list, let alone reorder it.
  assert.equal(groupedByEcosystem(input), input);
});

// --- the tree ----------------------------------------------------------------

test('flat mode draws one row per manifest, at the root', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'flat' } });
  assert.deepEqual(ids(buildTreeRoots([WEB, ENGINE, API])), [
    'group:file:///repo/web/package.json',
    'group:file:///repo/engine/Cargo.toml',
    'group:file:///repo/api/package.json',
  ]);
});

test('ecosystem mode puts the manifest groups under a parent per ecosystem', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'ecosystem' } });
  const roots = buildTreeRoots([WEB, API, ENGINE]);
  assert.deepEqual(ids(roots), ['group:eco:node', 'group:eco:rust']);
  assert.equal(roots[0].label, 'Node (2)');
  assert.equal(roots[1].label, 'Rust (1)');
  // The manifest groups keep the ids and refs every store is keyed by.
  assert.deepEqual(ids(roots[0].children), [
    'group:file:///repo/web/package.json',
    'group:file:///repo/api/package.json',
  ]);
  assert.equal(roots[0].children[0].ref, 'file:///repo/web/package.json');
  // A parent has no ref, which is what keeps Rename, Hide and Open Manifest off
  // it — there is no name on disk for either to act on.
  assert.equal(roots[0].ref, undefined);
  assert.equal(roots[0].scope, undefined);
  assert.equal(roots[0].manifest, undefined);
});

test('a single manifest gets no parent row of its own', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'ecosystem' } });
  assert.deepEqual(ids(buildTreeRoots([WEB])), ['group:file:///repo/web/package.json']);
});

test('favorites, OTHER TASKS and the hidden pile stay at the root', () => {
  const { buildTreeRoots } = harness({
    settings: { grouping: 'ecosystem' },
    stored: {
      favorites: ['file:///repo/web/package.json::dev'],
      hidden: ['file:///repo/api/package.json'],
    },
    executions: [{ task: { name: 'watch', source: 'npm' } }],
  });
  const roots = buildTreeRoots([WEB, API, ENGINE, TOOLS]);
  assert.deepEqual(ids(roots), [
    'script:dev',
    'group:foreign',
    'group:eco:node',
    'group:eco:rust',
    'group:eco:make',
    'group:hidden',
  ]);
  // The pile holds manifest groups, not parents: a pile routinely spans
  // ecosystems, and most parents in it would hold one child.
  assert.deepEqual(ids(roots[5].children), ['group:file:///repo/api/package.json']);
  // And the parent's count is of what is shown, since hidden is split off first.
  assert.equal(roots[2].label, 'Node (1)');
});

// --- the rows themselves -----------------------------------------------------

test('an ecosystem row is its own kind of row, idle and running', () => {
  const h = harness({ settings: { grouping: 'ecosystem' } });
  const roots = h.buildTreeRoots([WEB, API, ENGINE]);

  const idle = h.treeItemFor(roots[0]);
  // Not `group:package`, which is what Rename, Hide and Open Manifest match, and
  // not the bare `group` OTHER TASKS carries, which has no stop-all button.
  assert.equal(idle.contextValue, 'group:eco');
  assert.equal(idle.id, 'group:eco:node');
  assert.equal(idle.iconPath.id, 'package');
  // The glyph says which ecosystem it is; the colour is the one every heading
  // wears unless somebody painted this one.
  assert.equal(idle.iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');

  // Something alive two levels down still puts the buttons on the parent.
  h.running.set(API.key, { task: { name: 'start' } });
  assert.equal(h.treeItemFor(roots[0]).contextValue, 'group:eco:running');
  assert.equal(h.treeItemFor(roots[1]).contextValue, 'group:eco');
});

test('a manifest heading takes its own file\'s icon, and the uniform one when told to', () => {
  // No codicon font carries the npm, Rust or Docker marks, so the heading asks
  // the user's file icon theme for the icon its manifest has in the Explorer.
  const typed = harness({ settings: { groupIcons: 'type' } });
  const typedRow = typed.treeItemFor(typed.buildTreeRoots([ENGINE])[0]);
  assert.deepEqual({ ...typedRow.iconPath }, { themeFile: true });
  // A theme can only match on a file name, and the scheme has to stay ours so
  // the colour below never reaches the real file in the Explorer — so the
  // decoration uri carries both.
  assert.equal(typedRow.resourceUri.scheme, 'taskrunnerultimate');
  assert.equal(path.posix.basename(typedRow.resourceUri.path), 'Cargo.toml');

  const uniform = harness({ settings: { groupIcons: 'uniform' } });
  const uniformRow = uniform.treeItemFor(uniform.buildTreeRoots([ENGINE])[0]);
  assert.equal(uniformRow.iconPath.id, 'layers');
  assert.equal(uniformRow.iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');
});

test('a folder of scripts wears a terminal, not the theme\'s folder', () => {
  // It is the one heading with no file behind it, and a theme can only match on
  // a file name — so where every other heading asks the theme, this one says
  // what its rows are: scripts read by a shell.
  const h = harness({});
  const scripts = shell('/repo/scripts', 'deploy.sh');
  const row = h.treeItemFor(h.buildTreeRoots([scripts])[0]);
  assert.equal(row.iconPath.id, 'terminal-bash');
  assert.equal(row.iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');

  // And it follows `groupIcons` like every other heading.
  const uniform = harness({ settings: { groupIcons: 'uniform' } });
  assert.equal(uniform.treeItemFor(uniform.buildTreeRoots([scripts])[0]).iconPath.id, 'layers');
});

test('a shell row wears the terminal its file is read by', () => {
  const h = harness({});
  const glyph = (name) => h.iconFor(shell('/repo/bin', name), false).id;
  assert.equal(glyph('entrypoint.sh'), 'terminal-bash');
  assert.equal(glyph('helpers.zsh'), 'terminal');
  assert.equal(glyph('profile.ps1'), 'terminal-powershell');
  assert.equal(glyph('envsetup.bat'), 'terminal-cmd');
  // A category still reads the name first: `deploy.sh` is a deployment before it
  // is a shell script, and `play` is what the terminal replaced.
  assert.equal(glyph('deploy.sh'), 'rocket');
  // And a manifest task is untouched by any of it.
  assert.equal(h.iconFor(script('/repo/package.json', 'serve', 'npm'), false).id, 'play');
});

test('Add to Terminal is offered on the shell rows and nowhere else', () => {
  const h = harness({});
  const axes = (script) => h.treeItemFor({ kind: 'script', script }).contextValue;
  // The fourth axis, in front of the one the `when` clauses anchor with `$`.
  assert.equal(axes(shell('/repo/scripts', 'deploy.sh')), 'script:idle:nofav:shell:noconfirm');
  assert.equal(axes(script('/repo/package.json', 'dev', 'npm')), 'script:idle:nofav:task:noconfirm');
  // The clauses that were there before still read the axes they always did.
  assert.match(axes(shell('/repo/scripts', 'deploy.sh')), /^script:.+:noconfirm$/);
  assert.match(axes(shell('/repo/scripts', 'deploy.sh')), /^script:.+:nofav:/);
  assert.match(axes(shell('/repo/scripts', 'deploy.sh')), /^script:(idle|up):/);
});

test('Add to Terminal types the command line without running it', async () => {
  const h = harness({});
  const script = { ...shell('/repo/scripts', 'deploy.sh'), argv: ['bash', './scripts/deploy.sh'] };
  await h.addToTerminal({ kind: 'script', script });
  assert.equal(h.terminals.length, 1);
  const terminal = h.terminals[0];
  // Named after the row, and opened where the task itself would have run — the
  // workspace folder root, which is what the relative path in the line means.
  assert.equal(terminal.name, 'deploy.sh');
  assert.equal(terminal.cwd.path, '/repo');
  assert.equal(terminal.shown, 1);
  // Typed, not run: the whole point is the arguments the user adds next.
  assert.deepEqual(terminal.sent, [{ text: 'bash ./scripts/deploy.sh', execute: false }]);
});

test('Add to Terminal hands the shell a literal path, never a substitution', async () => {
  // A script checked out under a hostile name used to be typed in double quotes,
  // which every shell that matters substitutes inside: pressing Enter ran the
  // substitution and then a path that was not the row that was clicked.
  const hostile = {
    ...shell('/repo/scripts', '$(printf injected).sh'),
    argv: ['bash', './scripts/$(printf injected).sh'],
  };

  const posix = harness({});
  await posix.addToTerminal({ kind: 'script', script: hostile });
  assert.deepEqual(posix.terminals[0].sent, [
    { text: "bash './scripts/$(printf injected).sh'", execute: false },
  ]);

  // PowerShell substitutes inside double quotes too, and writes an inner quote
  // by doubling it.
  const pwsh = harness({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
  await pwsh.addToTerminal({
    kind: 'script',
    script: { ...hostile, argv: ['bash', "./scripts/it's $(id).sh"] },
  });
  assert.deepEqual(pwsh.terminals[0].sent, [
    { text: "bash './scripts/it''s $(id).sh'", execute: false },
  ]);

  // Git Bash on Windows is a POSIX shell on a machine whose default is not, and
  // the name is what says so.
  const gitBash = harness({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' });
  await gitBash.addToTerminal({
    kind: 'script',
    script: { ...hostile, argv: ['bash', "./scripts/it's $(id).sh"] },
  });
  assert.deepEqual(gitBash.terminals[0].sent, [
    { text: "bash './scripts/it'\\''s $(id).sh'", execute: false },
  ]);

  // And an ordinary line is left bare: this one is written to be edited by hand.
  const plain = harness({});
  await plain.addToTerminal({
    kind: 'script',
    script: { ...shell('/repo/scripts', 'deploy.sh'), argv: ['bash', './scripts/deploy.sh'] },
  });
  assert.deepEqual(plain.terminals[0].sent, [{ text: 'bash ./scripts/deploy.sh', execute: false }]);
});

test('both shell runner settings throw the scan away', () => {
  // `collectShellScripts` bakes the words in front of the path into `argv`, so a
  // runner changed while the cache stands would keep launching the old command.
  const { SCAN_SETTINGS } = harness({});
  assert.ok([...SCAN_SETTINGS].includes('shellRunner'));
  assert.ok([...SCAN_SETTINGS].includes('shellRunners'));
});

test('the grouping switch writes where the value that wins already lives', async () => {
  // A repository may pin `grouping` in its own settings, and a global write is
  // then shadowed by it — the button switched nothing and said nothing.
  const plain = harness({});
  await plain.setGrouping('ecosystem');
  assert.deepEqual(plain.writes, [{ key: 'grouping', value: 'ecosystem', target: 'global' }]);
  assert.deepEqual(plain.warnings, []);
  assert.equal(plain.settings.grouping, 'ecosystem');

  const repo = harness({ pinned: { grouping: 'flat' } });
  await repo.setGrouping('ecosystem');
  assert.deepEqual(repo.writes, [{ key: 'grouping', value: 'ecosystem', target: 'workspace' }]);

  // And when even that is not the value with the last word — a folder setting,
  // which needs a resource this view does not have — the row says so instead of
  // looking broken.
  assert.equal(repo.warnings.length, 1);
  assert.match(repo.warnings[0], /taskRunnerUltimate\.grouping/);
});

test('Add to Terminal calls a quoted command word in PowerShell', async () => {
  // `.bat` and `.cmd` have no runner by design, so the path *is* the command
  // word — and a quoted string at the start of a PowerShell line is a value it
  // prints, not a program it runs.
  const pwsh = harness({ shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  const bat = { ...shell('/repo/scripts', 'build all.bat'), argv: ['./scripts/build all.bat'] };
  await pwsh.addToTerminal({ kind: 'script', script: bat });
  assert.deepEqual(pwsh.terminals[0].sent, [{ text: "& './scripts/build all.bat'", execute: false }]);

  // A word that needed no quoting is already a command, and takes no operator.
  const ok = harness({ shell: 'pwsh.exe' });
  await ok.addToTerminal({
    kind: 'script',
    script: { ...shell('/repo/scripts', 'setup.ps1'), argv: ['powershell', '-NoProfile', '-File', './scripts/setup.ps1'] },
  });
  assert.deepEqual(ok.terminals[0].sent, [
    { text: 'powershell -NoProfile -File ./scripts/setup.ps1', execute: false },
  ]);

  // POSIX runs a quoted command word as it is, so nothing is added there.
  const posix = harness({});
  await posix.addToTerminal({ kind: 'script', script: bat });
  assert.deepEqual(posix.terminals[0].sent, [{ text: "'./scripts/build all.bat'", execute: false }]);
});

test('a row whose containers are up follows colorIcons like every other icon', () => {
  const up = {
    ...script('/repo/docker-compose.yml', 'up', 'docker-compose'),
    command: 'docker compose -f docker-compose.yml up',
  };
  const on = harness({});
  on.containers.set('file:///repo/docker-compose.yml', new Set(['web']));
  assert.equal(on.treeItemFor({ kind: 'script', script: up }).iconPath.color.id, 'taskRunnerUltimate.runningForeground');

  // The setting promises every icon in the default foreground, and a row that
  // opted out of colour did not opt out of it only while idle.
  const off = harness({ settings: { colorIcons: false } });
  off.containers.set('file:///repo/docker-compose.yml', new Set(['web']));
  const icon = off.treeItemFor({ kind: 'script', script: up }).iconPath;
  assert.equal(icon.id, 'debug-start');
  assert.equal(icon.color, undefined);
});

test('one heading leaving the pile does not lift the rule off the rest', async () => {
  // The bring-back exemption used to be read per gesture: a multi-select holding
  // one hidden heading let every other heading in it leave its project, and the
  // next repaint put them straight back — the "nothing happened" the refusal is
  // there to avoid.
  const PKG = script('/repo/package.json', 'build', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const API = script('/repo/api/package.json', 'dev', 'npm');
  const OTHER = script('/repo/api/docker-compose.yml', 'up', 'docker-compose');
  const scan = [PKG, COMPOSE, API, OTHER];
  const h = harness({ scan, stored: { hidden: ['file:///repo/api/docker-compose.yml'] } });

  const roots = h.buildTreeRoots(scan);
  const api = roots.find((node) => node.id === 'group:file:///repo/api/package.json');
  // The hidden one travels with a compose file that belongs to the root project.
  await h.dropGroups(['file:///repo/api/docker-compose.yml', 'file:///repo/docker-compose.yml'], api, undefined);
  assert.equal(h.memento.data.groupOrder, undefined, 'the drop must be refused, not written');
  assert.match(h.hints.at(-1), /Not a drop target/);
});

test('Add to Terminal has nothing to open for a row that is not a script', async () => {
  const h = harness({});
  await h.addToTerminal(h.buildTreeRoots([script('/repo/package.json', 'dev', 'npm')])[0]);
  await h.addToTerminal(undefined);
  assert.deepEqual(h.terminals, []);
});

test('a painted heading keeps both its colour and its file icon', () => {
  // The decoration colours the label and leaves the icon alone, which is what
  // lets a heading carry a paint of yours and its own logo at once.
  const h = harness({ stored: { colors: { 'file:///repo/engine/Cargo.toml': 'teal' } } });
  const row = h.treeItemFor(h.buildTreeRoots([ENGINE])[0]);
  assert.deepEqual({ ...row.iconPath }, { themeFile: true });
  assert.equal(row.resourceUri.path.split('/')[1], 'taskRunnerUltimate.palette.teal');
});

test('an icon picked by hand stands in for the theme\'s', () => {
  const h = harness({ stored: { icons: { 'file:///repo/engine/Cargo.toml': 'rocket' } } });
  const row = h.treeItemFor(h.buildTreeRoots([ENGINE])[0]);
  assert.equal(row.iconPath.id, 'rocket');
});

test('no heading is tinted by what kind of thing it is', () => {
  // A colour nobody chose on every heading is the one job the paint is for, so
  // an ecosystem row's glyph never carries one either.
  const h = harness({ settings: { grouping: 'ecosystem' } });
  const roots = h.buildTreeRoots([WEB, API, ENGINE]);
  assert.equal(h.treeItemFor(roots[0]).iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');
  // And the manifest rows under it answer to the file icon theme instead.
  assert.deepEqual({ ...h.treeItemFor(roots[0].children[0]).iconPath }, { themeFile: true });
});

// --- what a project takes in with it -----------------------------------------

const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
const ROOT = script('/repo/package.json', 'dev', 'npm');
const SCRIPTS = shell('/repo/scripts', 'deploy.sh');
const LOOSE = shell('/repo', 'release.sh');

test('flat mode draws compose and script folders inside the project they serve', () => {
  const { buildTreeRoots, treeItemFor } = harness({ settings: { grouping: 'flat' } });
  const roots = buildTreeRoots([ROOT, COMPOSE, SCRIPTS, LOOSE]);
  assert.deepEqual(ids(roots), ['group:file:///repo/package.json']);

  const inside = roots[0].children;
  // The project's own tasks first, then what sits around it: the compose file,
  // and one `shell` row for every script folder the project holds.
  assert.deepEqual(
    [...inside].map((node) => (node.kind === 'group' ? node.id : `script:${node.script.name}`)),
    [
      'script:dev',
      'group:file:///repo/docker-compose.yml',
      'group:shell:group:file:///repo/package.json',
    ],
  );
  // A compose file is named by its file, and drops the path the heading above
  // has already said.
  assert.equal(inside[1].place, 'docker-compose.yml');
  assert.equal(inside[1].folder, undefined);

  // Both folders are in the one row, each script saying which it came from —
  // and a script in the project's own folder has no path to name.
  const folder = inside[2];
  // Named after what it holds, and how much of it.
  assert.equal(folder.place, 'shell [2]');
  assert.deepEqual([...folder.children].map((node) => node.script.name), ['deploy.sh', 'release.sh']);
  assert.deepEqual([...folder.children].map((node) => node.origin), ['scripts', undefined]);
  assert.ok(treeItemFor(folder.children[0]).description.startsWith('scripts · '));
  // Two folders and no file: the row names nothing on disk, so it is the shape
  // an ecosystem row is — no rename, no hide, and stop-all all the same.
  assert.equal(folder.ref, undefined);
  assert.equal(treeItemFor(folder).contextValue, 'group:eco');
  assert.equal(treeItemFor(folder).iconPath.id, 'terminal-bash');
});

test('one folder behind the row leaves the row that folder', () => {
  // Renaming, hiding, painting and Open Folder all hang off the ref, and the
  // common case — a project with a single `scripts/` — must keep every one.
  const { buildTreeRoots, treeItemFor } = harness({ settings: { grouping: 'flat' } });
  const folder = buildTreeRoots([ROOT, SCRIPTS])[0].children[1];
  assert.equal(folder.ref, 'file:///repo/scripts');
  assert.equal(folder.scope, 'file:///repo/scripts');
  assert.equal(folder.manifest.path, '/repo/scripts');
  assert.equal(treeItemFor(folder).contextValue, 'group:package');
  // Still called `shell`, and still the folder it is on disk underneath: the
  // name a rename restores to is `label`, which the count never reaches. One
  // script is no count at all — `shell [1]` counts where there is nothing to
  // count.
  assert.equal(folder.place, 'shell');
  assert.equal(folder.label, 'scripts');
  // One folder, so nothing to tell the rows apart by.
  assert.deepEqual([...folder.children].map((node) => node.origin), [undefined]);
});

test('script folders with no project above them share one shell row', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'flat' } });
  const other = shell('/repo/bin', 'build.sh');
  const roots = buildTreeRoots([TOOLS, SCRIPTS, other]);
  // A Makefile hosts nothing, so the folders are at the root — in one row.
  assert.deepEqual(ids(roots), ['group:file:///repo/Makefile', 'group:shell:']);
  assert.deepEqual([...roots[1].children].map((node) => node.origin), ['scripts', 'bin']);
});

test('under Shell a script folder is its path, with no name in front of it', () => {
  // `scripts • apps/web` beside `scripts • apps/api` is a column of the one word
  // they share, read by its tails. The path is the name on these rows — the same
  // thing the dropdown has called them all along.
  const WEBS = shell('/repo/apps/web/scripts', 'build.sh');
  const CI = shell('/repo/tools/ci', 'lint.sh');
  const h = harness({ settings: { grouping: 'ecosystem' }, scan: [WEBS, CI] });
  const rows = h.buildTreeRoots([WEBS, CI]).find((node) => node.id === 'group:eco:shell').children;
  assert.deepEqual([...rows].map((row) => h.treeItemFor(row).label), [
    'repo/apps/web/scripts',
    'repo/tools/ci',
  ]);
  // The folder's own name is still what a rename restores to, and still what the
  // tooltip keeps: only the half the row shows has changed.
  assert.deepEqual([...rows].map((row) => row.label), ['scripts', 'ci']);
});

test('a script folder in the root of its workspace is that folder, as it always was', () => {
  // It has no path of its own to show, so the new rule and the old one agree.
  const ROOTS = shell('/repo', 'release.sh');
  const h = harness({ settings: { grouping: 'ecosystem' }, scan: [ROOTS, TOOLS] });
  const rows = h.buildTreeRoots([ROOTS, TOOLS]).find((node) => node.id === 'group:eco:shell').children;
  assert.equal(h.treeItemFor(rows[0]).label, 'repo');
});

test('flat mode names its shell row rather than pathing it', () => {
  // The path belongs to the `ecosystem` rows only: in `flat` mode these folders
  // are one `shell` row inside the project, and the dimmed column beside each
  // script is the folder's name — not the path of a row sitting right there.
  const h = harness({ settings: { grouping: 'flat' } });
  const other = shell('/repo/bin', 'build.sh');
  const bucket = h.buildTreeRoots([TOOLS, SCRIPTS, other])[1];
  assert.equal(h.treeItemFor(bucket).label, 'shell [2]');
  assert.deepEqual([...bucket.children].map((node) => node.origin), ['scripts', 'bin']);
  assert.equal(h.treeItemFor(h.buildTreeRoots([ROOT, SCRIPTS])[0].children[1]).label, 'shell');
});

test('what a project takes in does not make its folder look crowded', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'flat' } });
  // A compose file and a script folder sitting beside an unnamed package.json
  // used to count as a second manifest in that folder, which renames every
  // heading there after its file. Neither competes for the folder's name.
  const unnamed = { ...ROOT, packageName: undefined };
  const roots = buildTreeRoots([unnamed, COMPOSE, LOOSE]);
  // Its folder, as an uncrowded heading is named — not `package.json`, and not
  // the manifest path that a crowded one shows after the bullet.
  assert.equal(roots[0].place, 'repo');
  assert.equal(roots[0].folder, 'repo');
  assert.notEqual(roots[0].detail, roots[0].folder);
});

test('a compose file with no project above it stays a heading of its own', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'flat' } });
  // A Makefile is a task runner, not a statement that the folder is a project.
  assert.deepEqual(ids(buildTreeRoots([TOOLS, COMPOSE])), [
    'group:file:///repo/Makefile',
    'group:file:///repo/docker-compose.yml',
  ]);
});

test('a project takes in what sits in the folders below it, not beside it', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'flat' } });
  const nested = script('/repo/apps/web/package.json', 'dev', 'npm');
  const theirs = shell('/repo/apps/web/scripts', 'build.sh');
  const roots = buildTreeRoots([ROOT, nested, theirs, SCRIPTS]);
  assert.deepEqual(ids(roots), [
    'group:file:///repo/package.json',
    'group:file:///repo/apps/web/package.json',
  ]);
  // Each script folder went to the nearest project above it, not to the root —
  // as the one `shell` row of that project.
  assert.deepEqual(ids(roots[0].children.slice(1)), ['group:shell:group:file:///repo/package.json']);
  assert.deepEqual(ids(roots[1].children.slice(1)), [
    'group:shell:group:file:///repo/apps/web/package.json',
  ]);
  assert.equal(roots[1].children[1].ref, 'file:///repo/apps/web/scripts');
});

test('ecosystem mode files compose and shell by what they are, not by whom they serve', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'ecosystem' } });
  const roots = buildTreeRoots([ROOT, COMPOSE, SCRIPTS]);
  assert.deepEqual(ids(roots), ['group:eco:node', 'group:eco:docker', 'group:eco:shell']);
  // The compose file itself is what the Docker row opens into.
  assert.deepEqual(ids(roots[1].children), ['group:file:///repo/docker-compose.yml']);
  assert.equal(roots[1].children[0].place, 'docker-compose.yml');
});

// --- the landing position of a drop -------------------------------------------

/** The refs of a scan's groups, in the order `savedOrder` settles on. */
const scopes = (h, saved) => [...new Set([...saved].map((entry) => entry.manifest.toString()))];

test('a dragged block lands on the row it was dropped on, not past it', async () => {
  // Two packages in Node, one each in Rust and Make: dropping Node on Rust has
  // to leave Make behind it. Reading the anchor's index straight out of the
  // unfiltered order overshoots by the size of the block, which is invisible
  // with two ecosystems and wrong with three.
  const N1 = script('/repo/web/package.json', 'dev', 'npm');
  const N2 = script('/repo/api/package.json', 'start', 'npm');
  const R1 = script('/repo/engine/Cargo.toml', 'build', 'cargo');
  const M1 = script('/repo/Makefile', 'all', 'make');
  const scan = [N1, N2, R1, M1];
  const h = harness({ settings: { grouping: 'ecosystem' }, scan });

  const roots = h.buildTreeRoots(scan);
  const node = roots.find((n) => n.id === 'group:eco:node');
  const rust = roots.find((n) => n.id === 'group:eco:rust');
  await h.dropGroups([...node.children].map((c) => c.ref), rust, 'node');

  assert.deepEqual([...h.memento.data.groupOrder], [
    'file:///repo/engine/Cargo.toml',
    'file:///repo/web/package.json',
    'file:///repo/api/package.json',
    'file:///repo/Makefile',
  ]);
});

test('two headings dragged together land on the row they were dropped on', async () => {
  // The same arithmetic on the ordinary path: a multi-select must not overshoot
  // its target by the number of rows travelling with it.
  const A = script('/repo/a/package.json', 'dev', 'npm');
  const B = script('/repo/b/package.json', 'dev', 'npm');
  const C = script('/repo/c/package.json', 'dev', 'npm');
  const D = script('/repo/d/package.json', 'dev', 'npm');
  const scan = [A, B, C, D];
  const h = harness({ settings: { grouping: 'flat' }, scan });
  const roots = h.buildTreeRoots(scan);
  await h.dropGroups([roots[0].ref, roots[1].ref], roots[2], undefined);

  assert.deepEqual([...h.memento.data.groupOrder], [
    'file:///repo/c/package.json',
    'file:///repo/a/package.json',
    'file:///repo/b/package.json',
    'file:///repo/d/package.json',
  ]);
});

// --- a heading on its way out of the pile --------------------------------------

test('a hidden compose file comes back when it is dropped on a package', async () => {
  // The rule that a compose file stays inside its project has nothing to say
  // about one sitting in the pile: it is drawn inside nothing, and this drop is
  // the documented way back out.
  const PKG = script('/repo/package.json', 'build', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const API = script('/repo/api/package.json', 'dev', 'npm');
  const scan = [PKG, COMPOSE, API];
  const h = harness({ scan, stored: { hidden: ['file:///repo/docker-compose.yml'] } });

  const roots = h.buildTreeRoots(scan);
  const pile = roots.find((n) => n.id === 'group:hidden');
  const api = roots.find((n) => n.id === 'group:file:///repo/api/package.json');
  assert.deepEqual(ids(pile.children), ['group:file:///repo/docker-compose.yml']);

  await h.dropGroups([pile.children[0].ref], api, undefined);
  assert.deepEqual([...h.hiddenRefs()], []);
});

test('a heading whose project is hidden travels into the pile with it', async () => {
  // Putting a package away is putting the folder away, so what is drawn inside
  // it goes too — still inside it. Left behind, the compose file surfaced at the
  // root under the favorites, out of the folder the eye had just put away.
  const PKG = script('/repo/package.json', 'build', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const API = script('/repo/api/package.json', 'dev', 'npm');
  const scan = [PKG, COMPOSE, API];
  const h = harness({ scan, stored: { hidden: ['file:///repo/package.json'] } });

  const roots = h.buildTreeRoots(scan);
  assert.deepEqual(ids(roots), ['group:file:///repo/api/package.json', 'group:hidden']);
  const pile = roots[1];
  // One row put away, so one row to open onto — not the two refs behind it.
  assert.equal(pile.label, 'hidden (1)');
  assert.deepEqual(ids(pile.children), ['group:file:///repo/package.json']);
  const carried = pile.children[0].children.at(-1);
  assert.equal(carried.id, 'group:file:///repo/docker-compose.yml');

  // Neither eye on it: it is already in the pile, and it cannot leave on its own.
  assert.equal(h.treeItemFor(pile.children[0]).contextValue, 'group:package:hidden');
  assert.equal(h.treeItemFor(carried).contextValue, 'group:package:down:carried');

  // And the rule that it stays inside its project still holds, so the drop that
  // brings a put-away heading back is not its to make — honouring it would write
  // an order and leave the row exactly where it was.
  await h.dropGroups([carried.ref], roots[0], undefined);
  assert.equal(h.memento.data.groupOrder, undefined, 'the drop must be refused, not written');
  assert.match(h.hints.at(-1), /Not a drop target/);
});

test('a drop on a heading inside the pile puts the dragged package away', async () => {
  // The pile is a drop target all the way down: the hand that aims at a row in
  // there means the same thing whether that row was put away or only came along.
  const PKG = script('/repo/package.json', 'build', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const API = script('/repo/api/package.json', 'dev', 'npm');
  const scan = [PKG, COMPOSE, API];
  const h = harness({ scan, stored: { hidden: ['file:///repo/package.json'] } });

  const carried = h.buildTreeRoots(scan)[1].children[0].children.at(-1);
  await h.dropGroups(['file:///repo/api/package.json'], carried, undefined);
  assert.deepEqual([...h.hiddenRefs()], ['file:///repo/package.json', 'file:///repo/api/package.json']);
});

// --- one order, both surfaces --------------------------------------------------

test('the dropdown lists the blocks in the order the tree nests them', async () => {
  // `runScan` appends the shell groups after every manifest, so without an
  // ordering pass the tree drew `scripts` inside the root package while the
  // dropdown listed it last — two orders for what the README calls one thing.
  const PKG = script('/repo/package.json', 'build', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const API = script('/repo/api/package.json', 'dev', 'npm');
  const SCRIPTS = shell('/repo/scripts', 'deploy.sh');
  const scan = [PKG, COMPOSE, API, SCRIPTS];
  const h = harness({ scan });

  const saved = await h.savedOrder();
  assert.deepEqual(scopes(h, saved), [
    'file:///repo/package.json',
    'file:///repo/docker-compose.yml',
    'file:///repo/scripts',
    'file:///repo/api/package.json',
  ]);

  const roots = h.buildTreeRoots(saved);
  assert.deepEqual(ids(roots), [
    'group:file:///repo/package.json',
    'group:file:///repo/api/package.json',
  ]);
  assert.deepEqual(ids(roots[0].children.slice(1)), [
    'group:file:///repo/docker-compose.yml',
    'group:shell:group:file:///repo/package.json',
  ]);

  // The same blocks, in the same order, flattened.
  const separators = [...h.buildItems(saved)]
    .filter((item) => item.kind === -1)
    .map((item) => item.label);
  assert.deepEqual(separators, [
    'repo/package.json',
    'repo/docker-compose.yml',
    'repo/scripts',
    'repo/api/package.json',
  ]);
});

test('orderedByHost leaves an ecosystem-mode list alone', () => {
  const PKG = script('/repo/package.json', 'build', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const input = [PKG, COMPOSE];
  const { orderedByHost } = harness({ settings: { grouping: 'ecosystem' } });
  assert.equal(orderedByHost(input), input);
});

// --- a compose heading is its file ----------------------------------------------

test('two compose files sharing a `name:` stay tellable apart', () => {
  // The Compose Spec `name:` is very often the same word in both files of a
  // project, and inside a project heading there is no path left to separate the
  // rows — so the file name is what the heading shows.
  const PKG = script('/repo/package.json', 'dev', 'npm');
  const C1 = { ...script('/repo/docker-compose.yml', 'up', 'docker-compose'), packageName: 'acme' };
  const C2 = { ...script('/repo/docker-compose.dev.yml', 'up', 'docker-compose'), packageName: 'acme' };
  const { buildTreeRoots } = harness({ scan: [PKG, C1, C2] });
  const inside = buildTreeRoots([PKG, C1, C2])[0].children.filter((n) => n.kind === 'group');
  assert.deepEqual([...inside].map((n) => n.place), ['docker-compose.yml', 'docker-compose.dev.yml']);
  // And the file name is what it is called everywhere, not only on the row:
  // `label` is what the dropdown's separator and the rename prompt read, and
  // two of a project's compose files very often share one `name:`.
  assert.deepEqual([...inside].map((n) => n.label), ['docker-compose.yml', 'docker-compose.dev.yml']);
});

// --- the half after the bullet -------------------------------------------------

/** A manifest as the scan reports one inside a workspace folder at `/repo`. */
function inRepo(manifest, name, kind, packageName) {
  const location = path.posix.relative('/repo', manifest);
  return {
    key: `file://${manifest}::${name}`,
    name,
    command: name,
    manifest: uri(manifest),
    kind,
    packageName,
    cwd: uri(path.posix.dirname(manifest)),
    location,
    directory: location.includes('/') ? location.slice(0, location.lastIndexOf('/')) : '',
  };
}

test('the bullet carries the folder a heading lives in, never its file name again', () => {
  // `compose.yaml • compose.yaml` was the symptom: once the heading leads with a
  // file name, the path after the bullet has to say where that file is.
  const scan = [
    inRepo('/repo/compose.yaml', 'up', 'docker-compose'),
    inRepo('/repo/apps/web/docker-compose.yml', 'up', 'docker-compose'),
    inRepo('/repo/svc/Cargo.toml', 'build', 'cargo', 'engine'),
    inRepo('/repo/svc/Makefile', 'all', 'make'),
    inRepo('/repo/tools/Makefile', 'all', 'make'),
  ];
  const h = harness({ settings: { grouping: 'ecosystem' }, scan });
  const headings = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind !== 'group') continue;
      if (node.ref) headings.push(h.treeItemFor(node).label);
      walk(node.children);
    }
  };
  walk(h.buildTreeRoots(scan));

  // Docker leads, since the compose file is the first entry the scan reports.
  assert.deepEqual(headings, [
    // Nothing left to add for a compose file in the workspace root.
    'compose.yaml',
    'docker-compose.yml • apps/web',
    // A crowded folder leads with the file name and says which folder it is in.
    'engine • svc',
    'Makefile • svc',
    // A manifest alone in a folder is named by that folder, so the bullet would
    // only say it twice.
    'tools',
  ]);
});

// --- the two rows a stack is read by -------------------------------------------

test('two manifests in one folder stay tellable apart when they share a name', () => {
  // napi-rs, neon, wasm-pack and maturin all put a Cargo.toml beside a
  // package.json in one folder, and both declare the same name. The heading
  // leads with that name, so the half after the bullet has to be the one thing
  // that differs — the manifest path — or the tree draws the same row twice.
  const h = harness({ settings: { groupIcons: 'uniform' } });
  const rust = { ...script('/repo/crates/mylib/Cargo.toml', 'build', 'cargo'), packageName: 'mylib' };
  const node = { ...script('/repo/crates/mylib/package.json', 'dev', 'npm'), packageName: 'mylib' };
  const headings = [...h.buildTreeRoots([rust, node])].map((group) => h.treeItemFor(group).label);
  assert.deepEqual(headings, [
    'mylib • repo/crates/mylib/Cargo.toml',
    'mylib • repo/crates/mylib/package.json',
  ]);

  // A heading that leads with its own file name still says the folder after the
  // bullet: `compose.yaml • compose.yaml` said nothing twice.
  const first = { ...script('/repo/svc/docker-compose.yml', 'up', 'docker-compose'), packageName: 'acme' };
  const second = { ...script('/repo/svc/docker-compose.dev.yml', 'up', 'docker-compose'), packageName: 'acme' };
  assert.deepEqual(
    [...h.buildTreeRoots([first, second])].map((group) => h.treeItemFor(group).label),
    ['docker-compose.yml • repo/svc', 'docker-compose.dev.yml • repo/svc'],
  );
});

test('up is filled and green, down is hollow and red', () => {
  const h = harness({});
  const glyph = (name) => {
    const entry = {
      ...script('/repo/docker-compose.yml', name, 'docker-compose'),
      command: `docker compose -f docker-compose.yml ${name}`,
    };
    const icon = h.iconFor(entry, false, undefined);
    return [icon.id, icon.color && icon.color.id];
  };

  // Solid triangle for the row that starts everything, hollow square for the one
  // that stops it — the same pair as the row's own ▶ and ■ buttons.
  assert.deepEqual(glyph('up'), ['debug-start', 'taskRunnerUltimate.category.run']);
  assert.deepEqual(glyph('up: web'), ['debug-start', 'taskRunnerUltimate.category.run']);
  assert.deepEqual(glyph('down'), ['debug-stop', 'taskRunnerUltimate.category.stop']);

  // And the ordinary run words are untouched: `up` earning its own glyph must
  // not have dragged every dev server along with it.
  const dev = { ...script('/repo/package.json', 'dev', 'npm'), command: 'vite' };
  const icon = h.iconFor(dev, false, undefined);
  assert.deepEqual([icon.id, icon.color.id], ['play', 'taskRunnerUltimate.category.run']);
});

// --- what Docker said ----------------------------------------------------------

test('a compose row whose containers are up says so, and carries a stop', () => {
  const h = harness({});
  const row = (name) => ({
    ...script('/repo/docker-compose.yml', name, 'docker-compose'),
    command: `docker compose -f docker-compose.yml ${name}`,
  });
  const item = (name) => h.treeItemFor({ kind: 'script', script: row(name) });

  // Nobody has asked Docker yet: an empty map is not "nothing is running".
  assert.equal(item('up').contextValue.startsWith('script:idle:'), true);

  h.containers.set('file:///repo/docker-compose.yml', new Set(['web']));

  // The bare `up` stands for the whole file, so any service up marks it.
  const all = item('up');
  assert.equal(all.contextValue.startsWith('script:up:'), true);
  assert.equal(all.description.startsWith('up · '), true);
  // Its own glyph, in the running colour — not the spinner, which would promise
  // a process of ours to stop.
  assert.equal(all.iconPath.id, 'debug-start');
  assert.equal(all.iconPath.color.id, 'taskRunnerUltimate.runningForeground');

  // A per-service row is marked only for its own service.
  assert.equal(item('up: web').contextValue.startsWith('script:up:'), true);
  assert.equal(item('up: db').contextValue.startsWith('script:idle:'), true);
  // And the rows that are not about state are left alone.
  assert.equal(item('down').contextValue.startsWith('script:idle:'), true);
});

test('a run of ours outranks what Docker last said', () => {
  const h = harness({});
  const up = {
    ...script('/repo/docker-compose.yml', 'up', 'docker-compose'),
    command: 'docker compose -f docker-compose.yml up',
  };
  h.containers.set('file:///repo/docker-compose.yml', new Set(['web']));
  h.running.set(up.key, { task: { name: 'up' } });

  // While our own task runs, the row is a running row: the spinner is the better
  // answer, and its stop terminates the execution instead of shelling out.
  const item = h.treeItemFor({ kind: 'script', script: up });
  assert.equal(item.contextValue.startsWith('script:running:'), true);
  assert.equal(item.iconPath.id, 'loading~spin');
  assert.equal(item.description.startsWith('up · '), false);
});

test('the menu offers every row its button does, run and stop alike', () => {
  // The inline button and the right-click entry are one action in two places —
  // `runItem`/`runItemMenu` both land in `runNode`, `stopItem`/`stopItemMenu` in
  // `stopNode` — so a row either has the action or it does not. Drifting apart
  // cost `script:up:` its stop: a compose service Docker reported as up could be
  // stopped by a button that vanishes when the mouse leaves the row, and the
  // menu offered Run instead, with the heading's stop taking the whole stack
  // down as the only alternative.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const when = (command) =>
    manifest.contributes.menus['view/item/context']
      .filter((entry) => entry.command === `taskRunnerUltimate.${command}`)
      .map((entry) => entry.when);
  assert.deepEqual(when('runItemMenu'), when('runItem'));
  assert.deepEqual(when('stopItemMenu'), when('stopItem'));
  // And the row this is about is in both halves of the stop pair.
  const h = harness({ settings: { grouping: 'flat' } });
  h.containers.set('file:///repo/docker-compose.yml', new Set(['web']));
  const row = h.treeItemFor({
    kind: 'script',
    script: script('/repo/docker-compose.yml', 'up: web', 'docker-compose'),
  });
  assert.equal(row.contextValue.startsWith('script:up:'), true);
  for (const clause of [...when('stopItem'), ...when('stopItemMenu')]) {
    const [, pattern] = clause.match(/viewItem =~ \/(.+)\/$/);
    assert.match(row.contextValue, new RegExp(pattern), clause);
  }
});

// --- the two buttons a compose heading carries ---------------------------------

/** A compose file as the tree sees one: the bare `up`, a service row, and `down`. */
function composeFile(manifest = '/repo/docker-compose.yml') {
  const file = manifest.replace(/^.*\//, '');
  return ['up', 'up: web', 'down'].map((name) => ({
    ...script(manifest, name, 'docker-compose'),
    command: `docker compose -f ${file} ${name}`,
    argv: ['docker', 'compose', '-f', file, ...name.split(': ')],
  }));
}

test('a compose heading says whether its stack is up, and no other heading does', () => {
  const h = harness({ settings: { grouping: 'flat' } });
  const rows = composeFile();
  const heading = () => h.treeItemFor(h.buildTreeRoots(rows)[0]).contextValue;

  // Nobody has asked Docker yet, which is not "the stack is down" — but it is
  // not "up" either, and ▶ is what a heading in that state offers.
  assert.equal(heading(), 'group:package:down');
  h.containers.set('file:///repo/docker-compose.yml', new Set(['web']));
  assert.equal(heading(), 'group:package:up');

  // A run of ours outranks it, the way it does on the row: ⟳ and ■ take the slot.
  h.running.set(rows[0].key, { task: { name: 'up' } });
  assert.equal(heading(), 'group:package:up:running');
  h.running.clear();

  // Every clause that matched a package row before still matches one, compose or
  // not — the state rides in front of the anchored tail.
  assert.match(heading(), /^group:package(:(up|down))?(:hidden)?(:running)?$/);
  const npm = h.treeItemFor(h.buildTreeRoots([script('/repo/package.json', 'dev', 'npm')])[0]);
  assert.equal(npm.contextValue, 'group:package');
});

test('▶ on a compose heading runs the file\'s own up, and ■ stops its containers', async () => {
  const h = harness({ settings: { grouping: 'flat' } });
  const rows = composeFile();
  const heading = h.buildTreeRoots(rows)[0];

  await h.runGroup(heading);
  // The bare `up`, not `up: web`: the heading stands for the whole file.
  assert.deepEqual([...h.launched].map((task) => task.definition.script), ['up']);
  assert.match(h.launched[0].name, /^up\b/);

  await h.stopStack(heading);
  // Filed under the same row — the square belongs to the row it was pressed on —
  // with only the terminal's title saying what is being run.
  assert.deepEqual([...h.launched].map((task) => task.definition.script), ['up', 'up']);
  // `stop` and not `down` — the words themselves are `stopContainers`', which the
  // square on the row inside already hands to Docker.
  assert.match(h.launched[1].name, /^stop\b/);
});

test('a compose heading spins while any part of its stack runs', () => {
  const h = harness({ settings: { grouping: 'flat' } });
  const rows = composeFile();
  const heading = () => h.treeItemFor(h.buildTreeRoots(rows)[0]);

  // Idle, it is the file's own icon out of the theme, as every heading is.
  assert.deepEqual({ ...heading().iconPath }, { themeFile: true });

  // One service of six is the stack being up as far as this row is concerned —
  // and the row is folded shut most of the time, which is when a heading that
  // cannot say it is busy is one you have to open to find out.
  h.running.set(rows[1].key, { task: { name: 'up: web' } });
  assert.equal(heading().iconPath.id, 'loading~spin');
  assert.equal(heading().iconPath.color.id, 'taskRunnerUltimate.runningForeground');
  // It follows `colorIcons`, as the spinner on a row does.
  const plainIcons = harness({ settings: { grouping: 'flat', colorIcons: false } });
  plainIcons.running.set(rows[1].key, { task: { name: 'up: web' } });
  assert.equal(plainIcons.treeItemFor(plainIcons.buildTreeRoots(rows)[0]).iconPath.color, undefined);

  // Over an icon picked by hand too: "this one is busy" answers a different
  // question, and only while it is busy.
  const painted = harness({
    settings: { grouping: 'flat' },
    stored: { icons: { 'file:///repo/docker-compose.yml': 'rocket' } },
  });
  assert.equal(painted.treeItemFor(painted.buildTreeRoots(rows)[0]).iconPath.id, 'rocket');
  painted.running.set(rows[0].key, { task: { name: 'up' } });
  assert.equal(painted.treeItemFor(painted.buildTreeRoots(rows)[0]).iconPath.id, 'loading~spin');

  // And no other heading spins: a package holds tasks rather than being one, so
  // a monorepo with one `dev` running keeps a calm column of headings.
  const npm = harness({ settings: { grouping: 'flat' } });
  const dev = script('/repo/package.json', 'dev', 'npm');
  npm.running.set(dev.key, { task: { name: 'dev' } });
  assert.deepEqual({ ...npm.treeItemFor(npm.buildTreeRoots([dev])[0]).iconPath }, { themeFile: true });
});

test('the heading buttons have nothing to act on without an up row', async () => {
  const h = harness({ settings: { grouping: 'flat' } });
  // `composeCommands` narrowed to a list without `up`: there is no such thing as
  // bringing this file up, so the heading carries neither button.
  const rows = composeFile().filter((row) => row.name === 'down');
  const heading = h.buildTreeRoots(rows)[0];
  assert.equal(h.treeItemFor(heading).contextValue, 'group:package');
  await h.runGroup(heading);
  await h.stopStack(heading);
  // A package heading is not a stack either.
  await h.runGroup(h.buildTreeRoots([script('/repo/package.json', 'dev', 'npm')])[0]);
  assert.deepEqual(h.launched, []);
});

// --- what a heading looks like the first time it is seen ------------------------

test('a compose heading starts shut, and the store remembers opening it', () => {
  const PKG = script('/repo/package.json', 'dev', 'npm');
  const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
  const SCRIPTS = shell('/repo/scripts', 'deploy.sh');
  const scan = [PKG, COMPOSE, SCRIPTS];

  const h = harness({ scan });
  const roots = h.buildTreeRoots(scan);
  const state = (node) => h.treeItemFor(node).collapsibleState;
  const [compose, scripts] = roots[0].children.filter((node) => node.kind === 'group');

  // Seven rows for one file, most of them read rather than pressed: shut.
  assert.equal(state(compose), 1, 'compose starts collapsed');
  // Everything else is unchanged — the project and its script folder open.
  assert.equal(state(roots[0]), 2, 'the project starts expanded');
  assert.equal(state(scripts), 2, 'a script folder starts expanded');

  // For a group that starts shut the store holds the opposite exception, so a
  // ref in it means the user opened this one.
  const opened = harness({ scan, stored: { collapsed: ['file:///repo/docker-compose.yml'] } });
  const composeAgain = opened
    .buildTreeRoots(scan)[0]
    .children.filter((node) => node.kind === 'group')[0];
  assert.equal(opened.treeItemFor(composeAgain).collapsibleState, 2, 'a remembered open stays open');
});

// --- asking Docker again --------------------------------------------------------

/** A compose row as `parseCompose` builds one. */
function composeRow(manifest, name, tail) {
  const location = path.posix.relative('/repo', manifest);
  return {
    key: `file://${manifest}::${name}`,
    name,
    command: name,
    manifest: uri(manifest),
    kind: 'docker-compose',
    argv: ['docker', 'compose', '-f', path.posix.basename(manifest), ...tail],
    cwd: uri(path.posix.dirname(manifest)),
    location,
    directory: location.includes('/') ? location.slice(0, location.lastIndexOf('/')) : '',
  };
}

const C_UP = composeRow('/repo/docker-compose.yml', 'up', ['up']);
const C_DOWN = composeRow('/repo/docker-compose.yml', 'down', ['down']);
const MANIFEST = 'file:///repo/docker-compose.yml';

test('any compose task of ours refreshes the mark, not only an `up`', async () => {
  // `down` changes what is running as surely as `up` does, and so does the stop
  // the ■ builds — which is not a row of the scan at all. Reading the finished
  // row back and asking it for a probe prefix left both unrefreshed.
  const h = harness({ scan: [C_UP, C_DOWN] });
  await h.checkContainers(false);
  assert.equal(h.probes.length, 1, 'the question itself probes once');

  const task = (script) => ({ definition: { type: 'taskRunnerUltimate', script, manifest: MANIFEST } });
  await h.recheckAfter(task('down'));
  assert.equal(h.probes.length, 2, 'the `down` row re-probes');
  await h.recheckAfter(task('up'));
  assert.equal(h.probes.length, 3, 'and so does `up`');

  // A file nobody has asked about is still left alone — this is not a poll.
  await h.recheckAfter({ definition: { type: 'taskRunnerUltimate', script: 'up', manifest: 'file:///repo/other/compose.yml' } });
  assert.equal(h.probes.length, 3);
  // And neither is a task that is not ours at all.
  await h.recheckAfter({ definition: { type: 'npm', script: 'build' } });
  assert.equal(h.probes.length, 3);
});

test('the ■ stop belongs to the row it was pressed on', async () => {
  // Filed under a `stop` no scan declares, the task was one the badge counted
  // and no row showed — and `pruneRunning` dropped it again looking for the row
  // that key named.
  const h = harness({ scan: [C_UP, C_DOWN] });
  await h.stopContainers(C_UP);

  assert.equal(h.launched.length, 1);
  // The definition names the row, which is what `keyForTask` reads, so the task
  // system files this run against the row the square was on. (The harness stubs
  // `keyForTask` itself, so the definition is what there is to assert on.)
  assert.equal(h.launched[0].definition.script, 'up');
  assert.equal(h.launched[0].definition.manifest, MANIFEST);
});

test('the count is of the files just asked about, not of every file ever asked', async () => {
  const h = harness({ scan: [C_UP] });
  h.containers.set('file:///repo/gone/docker-compose.yml', new Set(['old-a', 'old-b']));
  await h.checkContainers(false);
  assert.deepEqual([...h.containers.keys()], [MANIFEST], 'a file the scan no longer has is dropped');
});

test('a file Docker could not answer for keeps its last answer', async () => {
  const h = harness({ scan: [C_UP], probeReply: () => undefined });
  h.containers.set(MANIFEST, new Set(['web']));
  await h.checkContainers(false);
  // "I could not ask" is not "your stack is down".
  assert.deepEqual([...(h.containers.get(MANIFEST) ?? [])], ['web']);
});

test('a put-away project still hosts, in the order as well as in the tree', async () => {
  // The compose file belongs to `api`, not to the project above it, and putting
  // `api` away does not hand it over: it goes into the pile inside `api`. The
  // dropdown is the same list flattened, so it has to file it in the same place
  // — the one thing `orderedByHost` exists to guarantee.
  const ROOTPKG = script('/repo/package.json', 'build', 'npm');
  const API = script('/repo/api/package.json', 'dev', 'npm');
  const APIC = composeRow('/repo/api/docker-compose.yml', 'up', ['up']);
  const scan = [ROOTPKG, API, APIC];
  const h = harness({ scan, stored: { hidden: ['file:///repo/api/package.json'] } });

  const saved = await h.savedOrder();
  const roots = h.buildTreeRoots(saved);
  // The root project keeps its own rows and gains none of `api`'s.
  assert.deepEqual(ids(roots), ['group:file:///repo/package.json', 'group:hidden']);
  assert.deepEqual(ids(roots[0].children), ['script:build']);
  const pile = roots[1];
  assert.deepEqual(ids(pile.children), ['group:file:///repo/api/package.json']);
  assert.deepEqual(ids(pile.children[0].children.slice(1)), [
    'group:file:///repo/api/docker-compose.yml',
  ]);
  // And the dropdown lists it in the same place.
  assert.deepEqual(
    [...h.buildItems(saved)].filter((item) => item.kind === -1).map((item) => item.label),
    ['repo/package.json', 'repo/api/package.json', 'api/docker-compose.yml'],
  );
});

test('a put-away project takes its script folder with it', async () => {
  // The shape the report came in as: a package hidden, and its shell and compose
  // rows left standing at the root under the favorites.
  const PKG = script('/repo/api/package.json', 'dev', 'npm');
  const SETUP = shell('/repo/api/scripts', 'setup.sh');
  const APIC = composeRow('/repo/api/docker-compose.yml', 'up', ['up']);
  const WEBPKG = script('/repo/web/package.json', 'dev', 'npm');
  const scan = [PKG, SETUP, APIC, WEBPKG];
  const h = harness({ scan, stored: { hidden: ['file:///repo/api/package.json'] } });

  const roots = h.buildTreeRoots(await h.savedOrder());
  assert.deepEqual(ids(roots), ['group:file:///repo/web/package.json', 'group:hidden']);
  const api = roots[1].children[0];
  assert.deepEqual(ids(api.children), [
    'script:dev',
    'group:shell:group:file:///repo/api/package.json',
    'group:file:///repo/api/docker-compose.yml',
  ]);
  // The one folder behind the row still leaves the row that folder, pile or not.
  assert.equal(api.children[1].ref, 'file:///repo/api/scripts');
});
