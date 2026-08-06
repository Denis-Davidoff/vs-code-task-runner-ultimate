/*
 * Generates media/*.svg and the generated parts of package.json:
 * the badge command variants and every menu contribution that references them.
 *
 * Run with `npm run gen` after changing the icon or the menu layout.
 */
const fs = require('fs');
const path = require('path');

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

// The activity bar uses the icon as a mask, so its colour does not matter and a
// single 24x24 file serves both themes.
fs.writeFileSync(
  path.join(media, 'activity-bar.svg'),
  svg(
    '  <path fill="#000000" fill-rule="evenodd" d="M12 1.4a10.6 10.6 0 1 0 0 21.2 10.6 10.6 0 0 0 0-21.2zm-2.8 5.5L17.4 12l-8.2 5.1z"/>',
    24,
  ),
);

// --- manifest ---------------------------------------------------------------

const manifestPath = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const icon = (suffix) => ({
  light: `media/scripts-light${suffix}.svg`,
  dark: `media/scripts-dark${suffix}.svg`,
});

const badgeEntries = variants.map((variant, index) => ({
  id: index < MAX_BADGE ? `packageScripts.show.badge${index + 1}` : 'packageScripts.show.badgeMany',
  count: index + 1,
  suffix: variant.suffix,
  label: variant.label,
}));

manifest.contributes.commands = [
  { command: 'packageScripts.show', title: 'Show Scripts', category: 'Package Scripts', icon: icon('') },
  ...badgeEntries.map((entry) => ({
    command: entry.id,
    title: `Show Scripts (${entry.label} running)`,
    category: 'Package Scripts',
    icon: icon(entry.suffix),
  })),
  { command: 'packageScripts.restartActive', title: 'Restart Focused Script', category: 'Package Scripts', icon: '$(debug-restart)' },
  { command: 'packageScripts.refresh', title: 'Refresh Scripts', category: 'Package Scripts', icon: '$(refresh)' },
  { command: 'packageScripts.runItem', title: 'Run', category: 'Package Scripts', icon: '$(play)' },
  { command: 'packageScripts.stopItem', title: 'Stop', category: 'Package Scripts', icon: '$(debug-stop)' },
  { command: 'packageScripts.restartItem', title: 'Restart', category: 'Package Scripts', icon: '$(debug-restart)' },
  { command: 'packageScripts.toggleItem', title: 'Run or Stop', category: 'Package Scripts' },
  { command: 'packageScripts.stopAll', title: 'Stop All Running Tasks', category: 'Package Scripts', icon: '$(stop-circle)' },
  { command: 'packageScripts.restartAll', title: 'Restart All Running Tasks', category: 'Package Scripts', icon: '$(debug-restart)' },
];

const inTitle = 'config.packageScripts.showInEditorTitle';
// `!packageScripts.runningCount` also covers the moment before the extension has
// activated, when the context key does not exist yet.
const toolbarEntries = (whenPrefix) => [
  { command: 'packageScripts.show', group: 'navigation@1', when: `${whenPrefix}!packageScripts.runningCount` },
  ...badgeEntries.map((entry) => ({
    command: entry.id,
    group: 'navigation@1',
    when: `${whenPrefix}packageScripts.runningCount == ${entry.count}`,
  })),
];

manifest.contributes.menus = {
  'editor/title': toolbarEntries(`${inTitle} && `),
  // Notebooks render their own toolbar instead of the editor title actions.
  'notebook/toolbar': toolbarEntries(`${inTitle} && `),
  'view/title': [
    {
      command: 'packageScripts.restartAll',
      group: 'navigation@1',
      when: 'view == packageScripts.tree && packageScripts.runningCount > 0',
    },
    {
      command: 'packageScripts.stopAll',
      group: 'navigation@2',
      when: 'view == packageScripts.tree && packageScripts.runningCount > 0',
    },
    { command: 'packageScripts.show', group: 'navigation@3', when: 'view == packageScripts.tree' },
    { command: 'packageScripts.refresh', group: 'navigation@4', when: 'view == packageScripts.tree' },
  ],
  'view/item/context': [
    { command: 'packageScripts.runItem', group: 'inline@1', when: 'view == packageScripts.tree && viewItem == idleScript' },
    { command: 'packageScripts.restartItem', group: 'inline@1', when: 'view == packageScripts.tree && viewItem =~ /^(runningScript|foreignTask)$/' },
    { command: 'packageScripts.stopItem', group: 'inline@2', when: 'view == packageScripts.tree && viewItem =~ /^(runningScript|foreignTask)$/' },
  ],
  commandPalette: [
    ...badgeEntries.map((entry) => ({ command: entry.id, when: 'false' })),
    { command: 'packageScripts.restartActive', when: 'false' },
    { command: 'packageScripts.runItem', when: 'false' },
    { command: 'packageScripts.stopItem', when: 'false' },
    { command: 'packageScripts.restartItem', when: 'false' },
    { command: 'packageScripts.toggleItem', when: 'false' },
  ],
};

manifest.contributes.viewsContainers = {
  activitybar: [
    {
      id: 'packageScripts',
      title: 'Scripts',
      icon: 'media/activity-bar.svg',
    },
  ],
};

manifest.contributes.views = {
  packageScripts: [
    {
      id: 'packageScripts.tree',
      name: 'Scripts',
      icon: 'media/activity-bar.svg',
      contextualTitle: 'Scripts',
    },
  ],
};

manifest.contributes.keybindings = [
  { command: 'packageScripts.show', key: 'ctrl+alt+r', mac: 'cmd+alt+r' },
  { command: 'packageScripts.restartActive', key: 'shift+enter', when: 'packageScripts.pickerOpen' },
];

manifest.contributes.taskDefinitions = [
  {
    type: 'packageScripts',
    required: ['script'],
    properties: {
      script: { type: 'string', description: 'Name of the package.json script.' },
      manifest: { type: 'string', description: 'URI of the package.json the script belongs to.' },
    },
  },
];

manifest.activationEvents = [
  'workspaceContains:**/package.json',
  'workspaceContains:**/deno.json',
  'workspaceContains:**/deno.jsonc',
  'onTaskType:packageScripts',
  'onView:packageScripts.tree',
];

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${variants.length * 2 + 3} svg files and patched package.json`);
