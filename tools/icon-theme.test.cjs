const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The catalogue is built by a function that never touches `vscode` — it is given
// a parsed theme file and a map of language names — so it is transpiled and run
// against the two of them and nothing else. What does touch `vscode` up there is
// finding the theme file and reading it, which is the part the workbench has to
// answer for anyway.
const source = fs.readFileSync(path.join(__dirname, '../src/iconTheme.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const context = vm.createContext({
  exports: {},
  Buffer,
  require: (name) =>
    name === 'vscode'
      ? { Uri: { joinPath: () => ({}) }, workspace: {}, extensions: { all: [] } }
      : name === './sources'
        ? { parseJsonc: JSON.parse }
        : {},
});
vm.runInContext(compiled, context);
const { iconsFrom } = context.exports;

/** A theme file with the definitions filled in for whatever the maps point at. */
function theme(maps) {
  const keys = new Set(
    ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded', 'languageIds'].flatMap(
      (map) => Object.values(maps[map] ?? {}),
    ),
  );
  return {
    iconDefinitions: Object.fromEntries([...keys].map((key) => [key, { iconPath: `./${key}.svg` }])),
    ...maps,
  };
}

const find = (icons, name) => icons.find((icon) => icon.name === name);

test('an extension becomes a file name the workbench can be shown', () => {
  const icons = iconsFrom(theme({ fileExtensions: { rs: '_f_rust' } }));
  assert.deepEqual(
    { ...find(icons, 'Rust'), art: undefined },
    { key: '_f_rust', name: 'Rust', kind: 'file', specimen: 'icon.rs', hint: '*.rs', art: undefined },
  );
});

test('an icon is only offered under a name that reaches it back', () => {
  // The made-up specimen for an extension is `icon.<ext>`, and a pack with a rule
  // for a file *called* that would send the row to a different icon than the one
  // the picker showed. So that pairing is dropped rather than shown wrong.
  const icons = iconsFrom(
    theme({ fileExtensions: { ts: '_f_typescript' }, fileNames: { 'icon.ts': '_f_other' } }),
  );
  assert.equal(find(icons, 'Typescript'), undefined);
  // The file name that does reach its own icon is still there.
  assert.equal(find(icons, 'Other').specimen, 'icon.ts');
});

test('a folder icon asks for a folder, and says so', () => {
  const icons = iconsFrom(theme({ folderNames: { src: '_fd_src' } }));
  const src = find(icons, 'Src');
  assert.deepEqual([src.kind, src.specimen, src.hint], ['folder', 'src', 'src/']);
});

test('the name an icon reads best under wins over the shortest one', () => {
  // A pack reaches the Docker icon by a dozen names. The picker prints one, and
  // it should be the one that says Docker.
  const icons = iconsFrom(
    theme({
      fileNames: {
        'compose.yml': '_f_docker',
        dockerfile: '_f_docker',
        'docker-compose.yml': '_f_docker',
      },
    }),
  );
  assert.equal(find(icons, 'Docker').specimen, 'dockerfile');
});

test('a language icon is taken only where no file rule answers first', () => {
  const languages = new Map([
    ['rust', 'icon.rs'],
    ['julia', 'icon.jl'],
  ]);
  const icons = iconsFrom(
    theme({ languageIds: { rust: '_f_rust', julia: '_f_julia' }, fileExtensions: { rs: '_f_other' } }),
    languages,
  );
  // `.rs` already belongs to another icon, so the language claim on it is refused
  // rather than drawn as somebody else's icon.
  assert.equal(find(icons, 'Rust'), undefined);
  assert.equal(find(icons, 'Julia').specimen, 'icon.jl');
});

test('the same icon in another state is not a second entry', () => {
  // Open folders and light variants are the same icons; the workbench picks the
  // state itself, from the row it is drawing.
  const base = theme({ folderNames: { src: '_fd_src' }, folderNamesExpanded: { src: '_fd_src_open' } });
  const icons = iconsFrom({
    ...base,
    // Given a definition of its own, so the assertion below fails if the light
    // block is ever read for a dark theme. Without one it would pass whatever
    // the code did, since a key with no definition is dropped either way.
    iconDefinitions: { ...base.iconDefinitions, _fd_light_src: { iconPath: './light.svg' } },
    light: { folderNames: { src: '_fd_light_src' } },
  });
  // Spread into this realm before it is compared: the catalogue is built inside
  // a `vm` context, and an array from there is never reference-equal to one here.
  assert.deepEqual([...icons].map((icon) => icon.key), ['_fd_src']);
});

test('a pack that draws from a font still lists, without the pictures', () => {
  // Seti, the one VS Code ships with, has no image to preview — and every one of
  // its icons is still reachable by name, which is the half that draws the row.
  const icons = iconsFrom({
    iconDefinitions: { _json: { fontCharacter: '\\E001' } },
    fileExtensions: { json: '_json' },
  });
  assert.deepEqual([...icons].map((icon) => [icon.name, icon.specimen, icon.art]), [
    ['Json', 'icon.json', undefined],
  ]);
});

test('a definition nothing points at is not offered', () => {
  const icons = iconsFrom({ iconDefinitions: { _f_ghost: { iconPath: './ghost.svg' } } });
  assert.deepEqual([...icons], []);
});

test('the prefixes a pack talks to itself in are dropped from the name', () => {
  const icons = iconsFrom(
    theme({
      fileNames: { 'a.b': '_f_docker', 'c.d': 'file_type_rust' },
      folderNames: { one: '_fd_android', two: 'folder-src' },
    }),
  );
  assert.deepEqual([...icons].map((icon) => icon.name).sort(), ['Android', 'Docker', 'Rust', 'Src']);
});

test('a theme that is not one at all comes back empty rather than throwing', () => {
  assert.deepEqual([...iconsFrom(undefined)], []);
  assert.deepEqual([...iconsFrom('nonsense')], []);
  assert.deepEqual([...iconsFrom({ iconDefinitions: null })], []);
});

// --- the colour theme picks which half of a pack is being drawn ----------------

test('a light theme is offered the icons a light theme draws', () => {
  // A pack's `light` block stands in front of its base associations, so the
  // catalogue has to be read through the same block the workbench draws through
  // — or the picker previews artwork the row will not wear.
  const base = theme({ fileExtensions: { ts: '_f_typescript', go: '_f_go' } });
  const spec = {
    ...base,
    iconDefinitions: { ...base.iconDefinitions, _f_light_ts: { iconPath: './light-ts.svg' } },
    light: { fileExtensions: { ts: '_f_light_ts' } },
  };

  const dark = [...iconsFrom(spec, new Map(), 'dark')].map((icon) => [icon.name, icon.art]);
  assert.deepEqual(dark, [
    ['Go', './_f_go.svg'],
    ['Typescript', './_f_typescript.svg'],
  ]);

  // `ts` takes the light artwork; `go`, which the block says nothing about,
  // keeps the base icon exactly as the workbench would.
  const light = [...iconsFrom(spec, new Map(), 'light')].map((icon) => [icon.name, icon.art]);
  assert.deepEqual(light, [
    ['Go', './_f_go.svg'],
    ['Ts', './light-ts.svg'],
  ]);
});

test('the word a pack marks its light artwork with is not part of the name', () => {
  // Otherwise every second row in a light theme opens with `Light`, which sorts
  // them under one letter and says only what the whole list already is.
  const base = theme({ fileExtensions: { a: '_x', b: '_y', c: '_z' } });
  const spec = {
    ...base,
    iconDefinitions: {
      ...base.iconDefinitions,
      _f_light_rust: { iconPath: './a.svg' },
      _argdown_light: { iconPath: './b.svg' },
      _f_lighthouse: { iconPath: './c.svg' },
    },
    light: { fileExtensions: { a: '_f_light_rust', b: '_argdown_light', c: '_f_lighthouse' } },
  };
  assert.deepEqual(
    [...iconsFrom(spec, new Map(), 'light')].map((icon) => icon.name),
    ['Argdown', 'Lighthouse', 'Rust'],
  );
});

test('a high contrast theme falls back to the block the pack actually ships', () => {
  const base = theme({ fileExtensions: { ts: '_ts' } });
  const spec = {
    ...base,
    iconDefinitions: { ...base.iconDefinitions, _hc: { iconPath: './hc.svg' }, _l: { iconPath: './l.svg' } },
    light: { fileExtensions: { ts: '_l' } },
    highContrast: { fileExtensions: { ts: '_hc' } },
  };
  assert.equal([...iconsFrom(spec, new Map(), 'hcDark')][0].art, './hc.svg');
  // Almost no pack ships a light high contrast block, and the workbench falls
  // back to the light one rather than to the dark artwork.
  assert.equal([...iconsFrom(spec, new Map(), 'hcLight')][0].art, './l.svg');
});

// --- themes that are hostile, or merely odd ------------------------------------

test('a name every object already answers to is not an icon', () => {
  // `constructor` and `toString` live on every object, so a lookup that only
  // asks whether the key is truthy would put a definition in the catalogue that
  // has no icon behind it at all.
  const icons = iconsFrom({
    iconDefinitions: { _real: { iconPath: './real.svg' } },
    fileExtensions: { js: 'constructor', ts: 'toString', rs: '_real' },
  });
  assert.deepEqual([...icons].map((icon) => icon.key), ['_real']);
});

test('an association qualified by a parent folder is left to a pass that can spell it', () => {
  // `icon.src/js` is a file called `js` inside a folder called `icon.src`, which
  // is not what `src/js` asks for — so no specimen is made up for it.
  const icons = iconsFrom({
    iconDefinitions: { _js: { iconPath: './js.svg' } },
    fileExtensions: { 'src/js': '_js' },
  });
  assert.deepEqual([...icons], []);
});

// --- finding, reading and holding on to a pack ---------------------------------

/**
 * The module with a workbench of its own: a settings value, a colour theme, a
 * list of installed extensions and a file system. This is the half `iconsFrom`
 * above cannot reach — which theme file is found, what is read, and what is kept.
 */
function loadPack({ id = 'pack', kind = 2, extensions, files = {}, sizes = {}, gate } = {}) {
  const reads = [];
  const uri = (at) => ({ fsPath: at, path: at, scheme: 'file', toString: () => at });
  const installed = extensions ?? [
    {
      extensionUri: uri('/ext'),
      packageJSON: {
        displayName: 'Pack',
        contributes: { iconThemes: [{ id: 'pack', label: 'Pack', path: 'dist/src/theme.json' }] },
      },
    },
  ];
  const vscode = {
    Uri: {
      joinPath: (base, ...rest) => uri(path.posix.normalize(path.posix.join(base.fsPath, ...rest))),
    },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: { activeColorTheme: { kind } },
    extensions: { all: installed },
    workspace: {
      getConfiguration: () => ({ get: () => id }),
      fs: {
        stat: async (at) => {
          const held = files[at.fsPath];
          if (held === undefined) {
            throw new Error(`ENOENT ${at.fsPath}`);
          }
          return { size: sizes[at.fsPath] ?? Buffer.byteLength(held) };
        },
        readFile: async (at) => {
          reads.push(at.fsPath);
          if (gate) {
            await gate();
          }
          const held = files[at.fsPath];
          if (held === undefined) {
            throw new Error(`ENOENT ${at.fsPath}`);
          }
          return new Uint8Array(Buffer.from(held, 'utf8'));
        },
      },
    },
  };
  const context = vm.createContext({
    exports: {},
    Buffer,
    require: (name) =>
      name === 'vscode' ? vscode : name === './sources' ? { parseJsonc: JSON.parse } : {},
  });
  vm.runInContext(compiled, context);
  return { ...context.exports, reads };
}

const THEME_FILE = JSON.stringify({
  iconDefinitions: { _rust: { iconPath: '../../icons/rust.svg' } },
  fileExtensions: { rs: '_rust' },
});
const AT = '/ext/dist/src/theme.json';

test('the pack named by the setting is found among the installed extensions', async () => {
  const mod = loadPack({ files: { [AT]: THEME_FILE } });
  const pack = await mod.iconPack();
  assert.equal(pack.label, 'Pack');
  assert.deepEqual([...pack.icons].map((icon) => [icon.name, icon.specimen]), [['Rust', 'icon.rs']]);
  // The artwork is relative to the theme file and reaches out of its folder,
  // which is where most packs keep their icons.
  assert.equal(mod.packArt('file', 'icon.rs').fsPath, '/ext/icons/rust.svg');
  assert.equal(mod.packArt('file', 'icon.nothing'), undefined);
});

test('a pack is read once and answered out of memory after that', async () => {
  const mod = loadPack({ files: { [AT]: THEME_FILE } });
  await mod.iconPack();
  await mod.iconPack();
  assert.deepEqual(mod.reads, [AT]);

  // Until something says it is no longer the pack on screen.
  mod.forgetIconPack();
  assert.equal(mod.packArt('file', 'icon.rs'), undefined);
  await mod.iconPack();
  assert.deepEqual(mod.reads, [AT, AT]);
});

test('an invalidation that lands mid-read is not overwritten by the read', async () => {
  // The pack being read is the one that just changed — an extension update is
  // exactly when both happen. Writing the finished read into the cache would put
  // the catalogue that was just dropped back, pointing at files that moved.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const mod = loadPack({ files: { [AT]: THEME_FILE }, gate: () => held });

  const reading = mod.iconPack();
  mod.forgetIconPack();
  release();
  await reading;

  assert.equal(mod.packArt('file', 'icon.rs'), undefined);
  // And the next ask reads again rather than serving what it refused to keep.
  await mod.iconPack();
  assert.deepEqual(mod.reads, [AT, AT]);
});

test('a theme file too large to hold is never pulled into the extension host', async () => {
  const mod = loadPack({ files: { [AT]: THEME_FILE }, sizes: { [AT]: 64 * 1024 * 1024 } });
  assert.equal(await mod.iconPack(), undefined);
  assert.deepEqual(mod.reads, []);
});

test('a pack that cannot be read or parsed is a picker without that section', async () => {
  assert.equal(await loadPack({ files: {} }).iconPack(), undefined);
  assert.equal(await loadPack({ files: { [AT]: 'not json at all' } }).iconPack(), undefined);
  assert.equal(await loadPack({ files: { [AT]: '{}' } }).iconPack(), undefined);
  // No pack is named at all: the workbench is drawing no file icons.
  assert.equal(await loadPack({ id: null, files: { [AT]: THEME_FILE } }).iconPack(), undefined);
});

test('a pack whose name never got translated is not offered under a placeholder', async () => {
  const mod = loadPack({
    files: { [AT]: THEME_FILE },
    extensions: [
      {
        extensionUri: { fsPath: '/ext', path: '/ext', scheme: 'file', toString: () => '/ext' },
        packageJSON: {
          displayName: 'Seti (Visual Studio Code)',
          contributes: { iconThemes: [{ id: 'pack', label: '%themeLabel%', path: 'dist/src/theme.json' }] },
        },
      },
    ],
  });
  assert.equal((await mod.iconPack()).label, 'Seti (Visual Studio Code)');
});

test('the colour theme is part of what the cache is holding', async () => {
  const light = loadPack({ kind: 1, files: { [AT]: THEME_FILE } });
  assert.equal((await light.iconPack()).variant, 'light');
  const dark = loadPack({ kind: 2, files: { [AT]: THEME_FILE } });
  assert.equal((await dark.iconPack()).variant, 'dark');
});
