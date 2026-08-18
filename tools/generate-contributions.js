/*
 * Generates media/*.svg and the generated parts of package.json:
 * the badge command variants and every menu contribution that references them.
 *
 * Run with `npm run gen` after changing the icon or the menu layout.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const media = path.join(root, 'media');
const MAX_BADGE = 9;

const THEMES = {
  light: { fg: '#424242', badge: '#005FB8', text: '#FFFFFF' },
  dark: { fg: '#C5C5C5', badge: '#0078D4', text: '#FFFFFF' },
};

/** Filled disc with the play triangle knocked out of it (evenodd fill rule). */
function glyph(fg) {
  return `  <path fill="${fg}" fill-rule="evenodd" d="M8 0.9a7.1 7.1 0 1 0 0 14.2A7.1 7.1 0 0 0 8 0.9zM6.1 4.6 11.6 8l-5.5 3.4z"/>`;
}

/** The same disc with a square knocked out instead of the triangle. */
function stopGlyph(fill) {
  return `  <path fill="${fill}" fill-rule="evenodd" d="M8 0.9a7.1 7.1 0 1 0 0 14.2A7.1 7.1 0 0 0 8 0.9zM5.6 5.6h4.8v4.8h-4.8z"/>`;
}

/**
 * Count badge, drawn over the bottom-right of a full-size glyph — the way the
 * activity bar badges its icon. The glyph is never shrunk to make room.
 */
function badge(theme, label) {
  const fontSize = label.length > 1 ? 5.2 : 6.4;
  return `  <circle cx="11.7" cy="11.7" r="4.3" fill="${theme.badge}"/>
  <text x="11.7" y="11.7" text-anchor="middle" dominant-baseline="central" fill="${theme.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700">${label}</text>`;
}

const svg = (inner, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">\n${inner}\n</svg>\n`;

const variants = [];
for (let n = 1; n <= MAX_BADGE; n++) variants.push({ suffix: `-${n}`, label: String(n) });
variants.push({ suffix: '-many', label: `${MAX_BADGE}+` });

fs.mkdirSync(media, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  fs.writeFileSync(path.join(media, `scripts-${name}.svg`), svg(glyph(theme.fg)));
  for (const variant of variants) {
    fs.writeFileSync(
      path.join(media, `scripts-${name}${variant.suffix}.svg`),
      svg(`${glyph(theme.fg)}\n${badge(theme, variant.label)}`),
    );
  }
}

/*
 * Stop-all is the one destructive action in the view header, so it is orange
 * rather than the theme foreground every other action uses. Menu icons declared
 * in package.json cannot carry a ThemeColor — only `$(id)` codicons or image
 * files are accepted, and the header draws those files as-is — so the colour is
 * baked in per theme: darker on light backgrounds, lighter on dark ones.
 */
const STOP_ORANGE = { light: '#B35C00', dark: '#E8952F' };
for (const [name, fill] of Object.entries(STOP_ORANGE)) {
  fs.writeFileSync(path.join(media, `stop-all-${name}.svg`), svg(stopGlyph(fill)));
}

// The activity bar uses the icon as a mask, so its colour does not matter and a
// single 24x24 file serves both themes.
fs.writeFileSync(
  path.join(media, 'activity-bar.svg'),
  svg(
    '  <path fill="#000000" fill-rule="evenodd" d="M12 1.4a10.6 10.6 0 1 0 0 21.2 10.6 10.6 0 0 0 0-21.2zm-2.8 5.5L17.4 12l-8.2 5.1z"/>',
    24,
  ),
);

// --- marketplace icon --------------------------------------------------------

/*
 * The Marketplace rejects SVG icons and wants at least 128x128, so the same
 * disc-and-triangle glyph is rasterised here into a PNG. Unlike the toolbar
 * icons the triangle is painted opaque white instead of knocked out, so the
 * icon reads identically on the light Marketplace page and in the dark
 * extensions sidebar.
 */
const ICON_SIZE = 256;
/** Subsamples per axis; the edges are antialiased by coverage alone. */
const ICON_SS = 4;
// The 16x16 glyph scaled by 16, so the proportions match the toolbar icons.
const DISC = { cx: 128, cy: 128, r: 113.6 };
const TRIANGLE = [
  [97.6, 73.6],
  [185.6, 128],
  [97.6, 182.4],
];
const DISC_FILL = [0x00, 0x78, 0xd4];
const TRIANGLE_FILL = [0xff, 0xff, 0xff];

const edge = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);

function insideTriangle(px, py, [a, b, c]) {
  const d1 = edge(px, py, a[0], a[1], b[0], b[1]);
  const d2 = edge(px, py, b[0], b[1], c[0], c[1]);
  const d3 = edge(px, py, c[0], c[1], a[0], a[1]);
  // Inside when every edge test agrees on a sign, whatever the winding is.
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Straight (non-premultiplied) RGBA, alpha carrying the subsample coverage. */
function renderIcon() {
  const pixels = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const samples = ICON_SS * ICON_SS;
  const step = 1 / ICON_SS;
  const radiusSquared = DISC.r * DISC.r;

  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      let covered = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let sy = 0; sy < ICON_SS; sy++) {
        for (let sx = 0; sx < ICON_SS; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          const dx = px - DISC.cx;
          const dy = py - DISC.cy;
          if (dx * dx + dy * dy > radiusSquared) {
            continue;
          }
          const fill = insideTriangle(px, py, TRIANGLE) ? TRIANGLE_FILL : DISC_FILL;
          covered++;
          red += fill[0];
          green += fill[1];
          blue += fill[2];
        }
      }

      if (covered === 0) {
        continue;
      }
      const offset = (y * ICON_SIZE + x) * 4;
      pixels[offset] = Math.round(red / covered);
      pixels[offset + 1] = Math.round(green / covered);
      pixels[offset + 2] = Math.round(blue / covered);
      pixels[offset + 3] = Math.round((covered / samples) * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** length + type + data + CRC, the PNG chunk layout. */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  // Bytes 10-12 stay zero: deflate, adaptive filtering, no interlacing.

  // Every scanline is prefixed with its filter byte; 0 means "no filtering",
  // which costs a little size and saves the filter heuristics entirely.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(path.join(media, 'icon.png'), encodePng(renderIcon(), ICON_SIZE));

// --- manifest ---------------------------------------------------------------

/*
 * The colours the right-click menu can paint a row with — keep in step with
 * PALETTE in src/extension.ts and with the taskRunnerUltimate.palette.* entries
 * in contributes.colors, which are written by hand.
 *
 * A submenu entry is a command and takes no argument, so each colour needs one
 * of its own; generating them is what keeps eleven commands, eleven menu entries
 * and eleven palette exclusions saying the same thing.
 *
 * The swatch is part of the title because a context menu draws no icons at all —
 * VS Code hands those menus to the platform, and `contributes.commands.icon` is
 * dropped on the way. A character in the label is the one thing that survives, so
 * the colour is spelled in the text rather than declared beside it.
 *
 * Seven of the ten are the coloured circles, which every platform has had since
 * 2019. Teal and pink have no circle in Unicode at all and grey's is a white one,
 * so those three take the nearest glyph that is the right colour — a shape the
 * label is not relying on, since the name is next to it either way. The newer
 * heart glyphs would have matched all ten exactly and are skipped on purpose:
 * they are Unicode 15, and on a machine whose emoji font predates them the menu
 * would show three empty boxes.
 */
const PALETTE = [
  { name: 'red', swatch: '🔴' },
  { name: 'orange', swatch: '🟠' },
  { name: 'yellow', swatch: '🟡' },
  { name: 'green', swatch: '🟢' },
  { name: 'teal', swatch: '💠' },
  { name: 'blue', swatch: '🔵' },
  { name: 'purple', swatch: '🟣' },
  { name: 'pink', swatch: '🌸' },
  { name: 'brown', swatch: '🟤' },
  { name: 'gray', swatch: '⚪' },
];

const COLOUR_SUBMENU = 'taskRunnerUltimate.color';
const colourCommand = (name) => `taskRunnerUltimate.setColor.${name}`;
const CLEAR_COLOUR = 'taskRunnerUltimate.clearColor';
const titleCase = (name) => name[0].toUpperCase() + name.slice(1);

const manifestPath = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.icon = 'media/icon.png';

const icon = (suffix) => ({
  light: `media/scripts-light${suffix}.svg`,
  dark: `media/scripts-dark${suffix}.svg`,
});

const badgeEntries = variants.map((variant, index) => ({
  id: index < MAX_BADGE ? `taskRunnerUltimate.show.badge${index + 1}` : 'taskRunnerUltimate.show.badgeMany',
  count: index + 1,
  suffix: variant.suffix,
  label: variant.label,
}));

manifest.contributes.commands = [
  { command: 'taskRunnerUltimate.show', title: 'Show Scripts', category: 'Task Runner Manager', icon: icon('') },
  ...badgeEntries.map((entry) => ({
    command: entry.id,
    title: `Show Scripts (${entry.label} running)`,
    category: 'Task Runner Manager',
    icon: icon(entry.suffix),
  })),
  { command: 'taskRunnerUltimate.restartActive', title: 'Restart Focused Script', category: 'Task Runner Manager', icon: '$(debug-restart)' },
  { command: 'taskRunnerUltimate.refresh', title: 'Refresh Scripts', category: 'Task Runner Manager', icon: '$(refresh)' },
  { command: 'taskRunnerUltimate.runItem', title: 'Run', category: 'Task Runner Manager', icon: '$(play)' },
  { command: 'taskRunnerUltimate.stopItem', title: 'Stop', category: 'Task Runner Manager', icon: '$(debug-stop)' },
  { command: 'taskRunnerUltimate.restartItem', title: 'Restart', category: 'Task Runner Manager', icon: '$(debug-restart)' },
  { command: 'taskRunnerUltimate.toggleItem', title: 'Run or Stop', category: 'Task Runner Manager' },
  { command: 'taskRunnerUltimate.addFavorite', title: 'Add to Favorites', category: 'Task Runner Manager', icon: '$(star-empty)' },
  { command: 'taskRunnerUltimate.removeFavorite', title: 'Remove from Favorites', category: 'Task Runner Manager', icon: '$(star-full)' },
  { command: 'taskRunnerUltimate.editTitle', title: 'Edit Title…', category: 'Task Runner Manager', icon: '$(edit)' },
  // The swatch rides in the title; see PALETTE above for why it is not an icon.
  // None of these reach the command palette (see commandPalette below), so the
  // glyph is only ever read where it means something.
  ...PALETTE.map(({ name, swatch }) => ({
    command: colourCommand(name),
    title: `${swatch} ${titleCase(name)}`,
    category: 'Task Runner Manager',
  })),
  { command: CLEAR_COLOUR, title: 'Default', category: 'Task Runner Manager' },
  { command: 'taskRunnerUltimate.menu', title: 'Menu', category: 'Task Runner Manager', icon: '$(menu)' },
  {
    command: 'taskRunnerUltimate.stopAll',
    title: 'Stop All Running Tasks',
    category: 'Task Runner Manager',
    icon: { light: 'media/stop-all-light.svg', dark: 'media/stop-all-dark.svg' },
  },
  { command: 'taskRunnerUltimate.restartAll', title: 'Restart All Running Tasks', category: 'Task Runner Manager', icon: '$(debug-restart)' },
];

const inTitle = 'config.taskRunnerUltimate.showInEditorTitle';
const inTree = 'view == taskRunnerUltimate.tree';
// `!taskRunnerUltimate.runningCount` also covers the moment before the extension has
// activated, when the context key does not exist yet.
const toolbarEntries = (whenPrefix) => [
  { command: 'taskRunnerUltimate.show', group: 'navigation@1', when: `${whenPrefix}!taskRunnerUltimate.runningCount` },
  ...badgeEntries.map((entry) => ({
    command: entry.id,
    group: 'navigation@1',
    when: `${whenPrefix}taskRunnerUltimate.runningCount == ${entry.count}`,
  })),
];

manifest.contributes.submenus = [
  { id: COLOUR_SUBMENU, label: 'Colour', icon: '$(symbol-color)' },
];

manifest.contributes.menus = {
  'editor/title': toolbarEntries(`${inTitle} && `),
  // Notebooks render their own toolbar instead of the editor title actions.
  'notebook/toolbar': toolbarEntries(`${inTitle} && `),
  'view/title': [
    {
      command: 'taskRunnerUltimate.restartAll',
      group: 'navigation@1',
      when: 'view == taskRunnerUltimate.tree && taskRunnerUltimate.runningCount > 0',
    },
    {
      command: 'taskRunnerUltimate.stopAll',
      group: 'navigation@2',
      when: 'view == taskRunnerUltimate.tree && taskRunnerUltimate.runningCount > 0',
    },
    { command: 'taskRunnerUltimate.show', group: 'navigation@3', when: 'view == taskRunnerUltimate.tree' },
    // Refresh lives inside the menu: it is the rarest of the header actions, and
    // the command palette still has it under its own name.
    { command: 'taskRunnerUltimate.menu', group: 'navigation@4', when: 'view == taskRunnerUltimate.tree' },
  ],
  // Script rows carry a composed contextValue — `script:<idle|running>:<fav|nofav>`
  // (see `treeItemFor`) — so a `when` clause can match on any one of the three
  // axes without a combinatorial list of context values.
  'view/item/context': [
    { command: 'taskRunnerUltimate.addFavorite', group: 'inline@0', when: `${inTree} && viewItem =~ /^script:.+:nofav$/` },
    { command: 'taskRunnerUltimate.removeFavorite', group: 'inline@0', when: `${inTree} && viewItem =~ /^script:.+:fav$/` },
    { command: 'taskRunnerUltimate.runItem', group: 'inline@1', when: `${inTree} && viewItem =~ /^script:idle:/` },
    { command: 'taskRunnerUltimate.restartItem', group: 'inline@1', when: `${inTree} && viewItem =~ /^(script:running:|foreignTask$)/` },
    { command: 'taskRunnerUltimate.stopItem', group: 'inline@2', when: `${inTree} && viewItem =~ /^(script:running:|foreignTask$)/` },
    // Non-inline groups are what the right-click menu shows.
    { command: 'taskRunnerUltimate.addFavorite', group: '1_favorites@1', when: `${inTree} && viewItem =~ /^script:.+:nofav$/` },
    { command: 'taskRunnerUltimate.removeFavorite', group: '1_favorites@1', when: `${inTree} && viewItem =~ /^script:.+:fav$/` },
    { command: 'taskRunnerUltimate.editTitle', group: '2_modify@1', when: `${inTree} && viewItem =~ /^script:/` },
    // The same command on a package heading. FAVORITES and the foreign-task
    // group are labels of ours rather than names read off disk, and carry the
    // plain `group` value, so neither matches.
    { command: 'taskRunnerUltimate.editTitle', group: '2_modify@1', when: `${inTree} && viewItem =~ /^group:package$/` },
    // Colour reaches further than a rename does: every row the tree draws itself
    // takes one — tasks, package headings, FAVORITES and OTHER TASKS. A rename
    // needs a name on disk to restore, which the last two do not have; a colour
    // needs nothing but a row. Only `foreignTask` is left out, and the regex is
    // what leaves it out.
    //
    // One entry, not one per kind of row, and that is load-bearing: a flyout is
    // identified by its submenu id, so the same id contributed twice to the same
    // menu is one submenu described two ways rather than two submenus. The two
    // `editTitle` lines above get away with it because a command is its own
    // action; a submenu is not.
    { submenu: COLOUR_SUBMENU, group: '2_modify@2', when: `${inTree} && viewItem =~ /^(script|group)/` },
  ],
  // The palette itself, in one group, with the way back to the default in a
  // second so the menu draws a separator above it.
  [COLOUR_SUBMENU]: [
    ...PALETTE.map(({ name }, index) => ({ command: colourCommand(name), group: `1_palette@${index + 1}` })),
    { command: CLEAR_COLOUR, group: '2_reset@1' },
  ],
  commandPalette: [
    ...badgeEntries.map((entry) => ({ command: entry.id, when: 'false' })),
    { command: 'taskRunnerUltimate.restartActive', when: 'false' },
    { command: 'taskRunnerUltimate.runItem', when: 'false' },
    { command: 'taskRunnerUltimate.stopItem', when: 'false' },
    { command: 'taskRunnerUltimate.restartItem', when: 'false' },
    { command: 'taskRunnerUltimate.toggleItem', when: 'false' },
    // All three act on the row they were invoked from, so they are useless
    // without one.
    { command: 'taskRunnerUltimate.addFavorite', when: 'false' },
    { command: 'taskRunnerUltimate.removeFavorite', when: 'false' },
    { command: 'taskRunnerUltimate.editTitle', when: 'false' },
    ...PALETTE.map(({ name }) => ({ command: colourCommand(name), when: 'false' })),
    { command: CLEAR_COLOUR, when: 'false' },
  ],
};

manifest.contributes.viewsContainers = {
  activitybar: [
    {
      id: 'taskRunnerUltimate',
      title: 'Task Runner Manager',
      icon: 'media/activity-bar.svg',
    },
  ],
};

manifest.contributes.views = {
  taskRunnerUltimate: [
    {
      id: 'taskRunnerUltimate.tree',
      name: 'Task Runner Manager',
      icon: 'media/activity-bar.svg',
      contextualTitle: 'Task Runner Manager',
    },
  ],
};

// `cmd+alt+r` is taken on macOS — it toggles regex in the find widget — and
// `cmd+alt+t` closes other editors there, so the mac binding uses ctrl+cmd,
// which VS Code leaves entirely free. On Windows and Linux ctrl+alt+t is
// unbound (the mac-only "close others" rule does not apply there).
manifest.contributes.keybindings = [
  { command: 'taskRunnerUltimate.show', key: 'ctrl+alt+t', mac: 'ctrl+cmd+t' },
  { command: 'taskRunnerUltimate.restartActive', key: 'shift+enter', when: 'taskRunnerUltimate.pickerOpen' },
];

manifest.contributes.taskDefinitions = [
  {
    type: 'taskRunnerUltimate',
    required: ['script'],
    properties: {
      script: { type: 'string', description: 'Name of the task in its manifest.' },
      manifest: { type: 'string', description: 'URI of the manifest the task belongs to.' },
    },
  },
];

/*
 * Every file name the scan knows about — keep in step with MANIFEST_KINDS in
 * src/sources.ts. They are listed one by one rather than as a single brace
 * glob so the Marketplace page shows exactly what makes the extension wake up.
 */
const MANIFEST_FILES = [
  'package.json',
  'deno.json',
  'deno.jsonc',
  'composer.json',
  'Cargo.toml',
  'Makefile.toml',
  'pyproject.toml',
  'Pipfile',
  'tox.ini',
  'noxfile.py',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  '.justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
  'Taskfile.dist.yml',
  'Taskfile.dist.yaml',
  'taskfile.yml',
  'taskfile.yaml',
  'go.mod',
  'mise.toml',
  '.mise.toml',
];

manifest.activationEvents = [
  ...MANIFEST_FILES.map((file) => `workspaceContains:**/${file}`),
  'onTaskType:taskRunnerUltimate',
  'onView:taskRunnerUltimate.tree',
];

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${variants.length * 2 + 3} svg files, icon.png and patched package.json`);
