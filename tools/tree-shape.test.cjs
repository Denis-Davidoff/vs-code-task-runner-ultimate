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

function harness({ settings = {}, stored = {}, executions = [] } = {}) {
  const vscode = {
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (key in settings ? settings[key] : fallback),
      }),
      // No folder for anything, which conveniently makes every storage ref the
      // plain URI string and keeps the expectations below readable.
      getWorkspaceFolder: () => undefined,
      workspaceFolders: undefined,
    },
    tasks: { taskExecutions: executions },
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
    },
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
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
    setTimeout,
    clearTimeout,
    require: (name) =>
      name === 'vscode'
        ? vscode
        : name === 'path'
          ? path
          : // The tree reads one thing out of the scan module, and it is the one
            // that decides which parent row a heading lands under.
            name === './sources'
            ? { ecosystemOf: (kind) => ECOSYSTEMS[kind], ALL_ECOSYSTEMS: [...new Set(Object.values(ECOSYSTEMS))] }
            : {},
  });

  vm.runInContext(
    compiled +
      `
    storage = memento;
    keyForTask = () => undefined;
    exports.tree = { buildTreeRoots, groupedByEcosystem, treeItemFor, running };
  `,
    Object.assign(context, { memento }),
  );
  return { ...context.exports.tree, memento, settings };
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

test('a manifest heading wears its type icon, and the uniform one when told to', () => {
  const typed = harness({ settings: { groupIcons: 'type' } });
  const typedRow = typed.treeItemFor(typed.buildTreeRoots([ENGINE])[0]);
  assert.equal(typedRow.iconPath.id, 'gear');
  assert.equal(typedRow.iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');

  const uniform = harness({ settings: { groupIcons: 'uniform' } });
  const uniformRow = uniform.treeItemFor(uniform.buildTreeRoots([ENGINE])[0]);
  assert.equal(uniformRow.iconPath.id, 'layers');
  assert.equal(uniformRow.iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');
});

test('a colour picked by hand outranks the ecosystem colour', () => {
  const h = harness({ stored: { colors: { 'file:///repo/engine/Cargo.toml': 'teal' } } });
  const row = h.treeItemFor(h.buildTreeRoots([ENGINE])[0]);
  assert.equal(row.iconPath.color.id, 'taskRunnerUltimate.palette.teal');
});

test('no heading is tinted by what kind of thing it is', () => {
  // A colour nobody chose on every heading is the one job the paint is for, so
  // the ecosystem decides the glyph and never the colour.
  const h = harness({ settings: { grouping: 'ecosystem' } });
  const roots = h.buildTreeRoots([WEB, API, ENGINE]);
  for (const row of [h.treeItemFor(roots[0]), h.treeItemFor(roots[0].children[0])]) {
    assert.equal(row.iconPath.color.id, 'taskRunnerUltimate.sourceTitleForeground');
  }
});

// --- what a project takes in with it -----------------------------------------

const COMPOSE = script('/repo/docker-compose.yml', 'up', 'docker-compose');
const ROOT = script('/repo/package.json', 'dev', 'npm');
const SCRIPTS = shell('/repo/scripts', 'deploy.sh');
const LOOSE = shell('/repo', 'release.sh');

test('flat mode draws compose and script folders inside the project they serve', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'flat' } });
  const roots = buildTreeRoots([ROOT, COMPOSE, SCRIPTS, LOOSE]);
  assert.deepEqual(ids(roots), ['group:file:///repo/package.json']);

  const inside = roots[0].children;
  // The project's own tasks first, then what sits around it.
  assert.deepEqual(
    [...inside].map((node) => (node.kind === 'group' ? node.id : `script:${node.script.name}`)),
    ['script:dev', 'group:file:///repo/docker-compose.yml', 'group:file:///repo/scripts', 'group:file:///repo'],
  );
  // A compose file is named by its file, and drops the path the heading above
  // has already said.
  assert.equal(inside[1].place, 'docker-compose.yml');
  assert.equal(inside[1].folder, undefined);
  // A script folder is named by where it sits relative to the project, and
  // `shell` is what is left when that is the project's own folder.
  assert.equal(inside[2].place, 'scripts');
  assert.equal(inside[3].place, 'shell');
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
  // Each script folder went to the nearest project above it, not to the root.
  assert.deepEqual(ids(roots[0].children.slice(1)), ['group:file:///repo/scripts']);
  assert.deepEqual(ids(roots[1].children.slice(1)), ['group:file:///repo/apps/web/scripts']);
});

test('ecosystem mode files compose and shell by what they are, not by whom they serve', () => {
  const { buildTreeRoots } = harness({ settings: { grouping: 'ecosystem' } });
  const roots = buildTreeRoots([ROOT, COMPOSE, SCRIPTS]);
  assert.deepEqual(ids(roots), ['group:eco:node', 'group:eco:docker', 'group:eco:shell']);
  // The compose file itself is what the Docker row opens into.
  assert.deepEqual(ids(roots[1].children), ['group:file:///repo/docker-compose.yml']);
  assert.equal(roots[1].children[0].place, 'docker-compose.yml');
});
