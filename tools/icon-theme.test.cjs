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
  const icons = iconsFrom({
    ...theme({
      folderNames: { src: '_fd_src' },
      folderNamesExpanded: { src: '_fd_src_open' },
    }),
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
