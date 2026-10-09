const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// The matcher touches nothing outside itself, so it is transpiled and run bare.
const source = fs.readFileSync(path.join(__dirname, '../src/gitignore.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ exports: {} });
vm.runInContext(compiled, context);
const { parseIgnore, ignoredBy, excludesFileOf } = context.exports;

/**
 * Whether `relative` is ignored inside `/repo`, the way the scan asks it: each
 * directory on the way down first, since nothing inside an ignored directory
 * comes back, then the path itself. `nested` holds `.gitignore` text by the
 * directory it sits in.
 */
function ignored(rootText, relative, { nested = {}, directory = false, ignoreCase = false } = {}) {
  const rulesIn = (dir) => [
    { base: '/repo', rules: parseIgnore(rootText, ignoreCase) },
    ...Object.entries(nested)
      .filter(([at]) => dir === at || dir.startsWith(`${at}/`))
      .sort(([a], [b]) => a.length - b.length)
      .map(([at, text]) => ({ base: `/repo/${at}`, rules: parseIgnore(text, ignoreCase) })),
  ];
  const parts = relative.split('/');
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const parent = parts.slice(0, depth - 1).join('/');
    const last = depth === parts.length;
    if (ignoredBy(rulesIn(parent), `/repo/${parts.slice(0, depth).join('/')}`, last ? directory : true)) {
      return true;
    }
  }
  return false;
}

test('Claude Code\'s worktrees directory hides every copy inside it, and nothing beside it', () => {
  const rules = '.claude/worktrees/\n';
  assert.equal(ignored(rules, '.claude/worktrees/agent-a241d3f6/package.json'), true);
  assert.equal(ignored(rules, '.claude/worktrees/agent-a241d3f6/e2e/package.json'), true);
  assert.equal(ignored(rules, '.claude/settings.json'), false);
  // A slash in the middle anchors it to the file's own directory.
  assert.equal(ignored(rules, 'apps/.claude/worktrees/x/package.json'), false);
});

test('a name with no slash matches at any depth; a leading slash pins it to the top', () => {
  assert.equal(ignored('tmp\n', 'tmp/package.json'), true);
  assert.equal(ignored('tmp\n', 'apps/web/tmp/package.json'), true);
  assert.equal(ignored('/tmp\n', 'tmp/package.json'), true);
  assert.equal(ignored('/tmp\n', 'apps/tmp/package.json'), false);
});

test('a trailing slash matches a directory and never a file of that name', () => {
  assert.equal(ignored('build/\n', 'build/package.json'), true);
  assert.equal(ignored('build/\n', 'build'), false);
  assert.equal(ignored('build/\n', 'build', { directory: true }), true);
});

test('the last pattern that matches decides, and a deeper file outranks the top one', () => {
  assert.equal(ignored('*.json\n!package.json\n', 'package.json'), false);
  assert.equal(ignored('!package.json\n*.json\n', 'package.json'), true);
  assert.equal(ignored('dist\n', 'pkg/dist/package.json', { nested: { pkg: '!dist\n' } }), false);
  assert.equal(ignored('dist\n', 'dist/package.json', { nested: { pkg: '!dist\n' } }), true);
});

test('nothing comes back from inside an ignored directory, `!` or not', () => {
  assert.equal(ignored('cache/\n!cache/package.json\n', 'cache/package.json'), true);
  // Bringing the directory itself back is what works.
  assert.equal(ignored('packages/*\n!packages/keep\n', 'packages/keep/package.json'), false);
  assert.equal(ignored('packages/*\n!packages/keep\n', 'packages/drop/package.json'), true);
});

test('`**` is any number of directories as a whole segment, and one `*` anywhere else', () => {
  assert.equal(ignored('**/fixtures\n', 'fixtures/package.json'), true);
  assert.equal(ignored('**/fixtures\n', 'a/b/fixtures/package.json'), true);
  assert.equal(ignored('a/**/b\n', 'a/b'), true);
  assert.equal(ignored('a/**/b\n', 'a/x/y/b'), true);
  // Trailing, it is everything inside — so the directory itself is still there,
  // and a directory in it can be brought back.
  assert.equal(ignored('docs/**\n', 'docs', { directory: true }), false);
  assert.equal(ignored('docs/**\n', 'docs/a.md'), true);
  // Bringing the directory back is not enough on its own: `docs/**` still
  // matches the file inside it by name, as `git check-ignore` agrees.
  assert.equal(ignored('docs/**\n!docs/keep/\n', 'docs/keep/package.json'), true);
  assert.equal(ignored('docs/**\n!docs/keep/\n!docs/keep/**\n', 'docs/keep/package.json'), false);
  assert.equal(ignored('a**b\n', 'axxb'), true);
  assert.equal(ignored('a**b\n', 'a/xb'), false);
});

test('`*`, `?` and brackets never match a slash', () => {
  assert.equal(ignored('a/*/c\n', 'a/b/c'), true);
  assert.equal(ignored('a/*/c\n', 'a/b/x/c'), false);
  assert.equal(ignored('p?ck\n', 'pack'), true);
  assert.equal(ignored('[a-c]x\n', 'bx'), true);
  assert.equal(ignored('[a-c]x\n', 'dx'), false);
  assert.equal(ignored('[!a-c]x\n', 'dx'), true);
  assert.equal(ignored('[!a-c]x\n', 'bx'), false);
  assert.equal(ignored('[]]x\n', ']x'), true);
  assert.equal(ignored('[[:digit:]]x\n', '1x'), true);
});

test('a pattern git cannot read matches nothing, rather than taking the file down', () => {
  // An unclosed bracket, an unknown class: nothing at all, not the text as written.
  assert.equal(ignored('x[\n', 'x['), false);
  assert.equal(ignored('x[[:foo:]]\n', 'xf]'), false);
  assert.equal(ignored('x[\nkeep-me-out\n', 'keep-me-out'), true);
  // A trailing backslash escapes nothing, and so matches nothing either.
  assert.equal(ignored('x\\\n', 'x\\'), false);
});

test('brackets follow git: a backwards range is empty, the rest of the set still counts', () => {
  assert.equal(ignored('x[z-ab]\n', 'xb'), true);
  // The `z` is a member before it is a range's start, so it still counts.
  assert.equal(ignored('x[z-ab]\n', 'xz'), true);
  assert.equal(ignored('x[z-ab]\n', 'xq'), false);
  assert.equal(ignored('x[!z-a]\n', 'xb'), true);
  // A `-` straight after `!` is a member, not a range from the `!`.
  assert.equal(ignored('x[!-a]\n', 'x5'), true);
  assert.equal(ignored('x[!-a]\n', 'x-'), false);
  // A slash inside one is never matched, and does not split the pattern.
  assert.equal(ignored('a[b/c]d\n', 'abd'), true);
  assert.equal(ignored('d/a[%-0]b\n', 'd/a/b'), false);
  assert.equal(ignored('x[[:punct:]]\n', 'x-'), true);
  assert.equal(ignored('x[[:punct:]]\n', 'xq'), false);
});

test('`***` is `**`, and an escaped slash is still a slash', () => {
  assert.equal(ignored('a/***/b\n', 'a/b'), true);
  assert.equal(ignored('a/***/b\n', 'a/x/y/b'), true);
  assert.equal(ignored('foo\\/bar\n', 'foo/bar'), true);
  // `**` glued to a name is one `*`, which stops at a slash.
  assert.equal(ignored('a**/b\n', 'a/x/b'), false);
  assert.equal(ignored('a**/b\n', 'aq/b'), true);
});

test('bytes, not characters: `?` is one byte, and only ASCII letters fold', () => {
  assert.equal(ignored('caf?\n', 'café'), false);
  assert.equal(ignored('caf??\n', 'café'), true);
  assert.equal(ignored('Élan/\n', 'élan/f', { ignoreCase: true }), false);
  assert.equal(ignored('ÉLAN/\n', 'Élan/f', { ignoreCase: true }), true);
});

test('a carriage return ends a line even on the last line, with no newline after it', () => {
  assert.equal(ignored('foo\r', 'foo'), true);
});

test('a hostile run of wildcards is answered at once, not after the host has frozen', () => {
  // As a regular expression this took seconds at sixteen `**` segments and
  // doubled with each one more; git's matcher gives up on a branch as soon as
  // the text runs out.
  const deep = Array.from({ length: 13 }, (_, at) => `d${at}`).join('/');
  const started = Date.now();
  assert.equal(ignored(`${'**/'.repeat(40)}zzz\n`, `${deep}/package.json`), false);
  assert.equal(ignored(`${'*e'.repeat(40)}x\n`, 'e'.repeat(60)), false);
  assert.equal(ignored(`${'a/**/'.repeat(30)}zzz\n`, `${'a/'.repeat(40)}x`), false);
  assert.ok(Date.now() - started < 2000);
});

test('comments, blank lines and trailing spaces are not patterns; escapes keep what they escape', () => {
  assert.equal(parseIgnore('# a comment\n\n   \n').length, 0);
  assert.equal(ignored('\\#hash\n', '#hash'), true);
  assert.equal(ignored('\\!bang\n', '!bang'), true);
  assert.equal(ignored('trail   \n', 'trail'), true);
  assert.equal(ignored('esc\\ \n', 'esc '), true);
  assert.equal(ignored('esc\\ \n', 'esc'), false);
  // A lone `/` or `!` is nothing at all, and certainly not "everything".
  assert.equal(parseIgnore('/\n!\n!/\n').length, 0);
  assert.equal(ignored('build\r\n', 'build'), true);
});

test('a rule reaches only below the directory its file is in', () => {
  const files = [{ base: '/repo/pkg', rules: parseIgnore('*\n') }];
  assert.equal(ignoredBy(files, '/repo/pkg/package.json', false), true);
  assert.equal(ignoredBy(files, '/repo/package.json', false), false);
  assert.equal(ignoredBy(files, '/repo/pkg', true), false);
  assert.equal(ignoredBy(files, '/repo/pkg2/package.json', false), false);
});

test('case matters unless the repository says it does not', () => {
  assert.equal(ignored('Build/\n', 'build/package.json'), false);
  assert.equal(ignored('Build/\n', 'build/package.json', { ignoreCase: true }), true);
});

test('a literal is the plain path a pattern names at the top of its directory', () => {
  const [worktrees, star, escaped, negated, deep] = parseIgnore(
    '/.claude/worktrees/\nbuild-*\nx\\ y\n!keep\n**/.claude/worktrees/\n',
  );
  // What Claude Code writes now: the same directory, at any depth.
  assert.equal(deep.literal, '.claude/worktrees');
  assert.equal(deep.directoryOnly, true);
  assert.equal(worktrees.literal, '.claude/worktrees');
  assert.equal(worktrees.anchored, true);
  assert.equal(worktrees.directoryOnly, true);
  assert.equal(star.literal, undefined);
  assert.equal(escaped.literal, undefined);
  assert.equal(negated.literal, 'keep');
  assert.equal(negated.negated, true);
});

test('the global excludes file is read out of `[core]`, the last setting winning', () => {
  assert.equal(excludesFileOf('[core]\n\texcludesFile = ~/.gitignore_global\n'), '~/.gitignore_global');
  assert.equal(excludesFileOf('[Core]\n  EXCLUDESFILE=/etc/ignore ; trailing\n'), '/etc/ignore');
  assert.equal(excludesFileOf('[core]\n\texcludesfile = "~/my ignore" # quoted\n'), '~/my ignore');
  assert.equal(excludesFileOf('[core]\nexcludesfile = /a\n[core]\nexcludesfile = /b\n'), '/b');
  // Another section, or a subsection of core, is not where the key lives.
  assert.equal(excludesFileOf('[user]\nexcludesfile = /a\n'), undefined);
  assert.equal(excludesFileOf('[core "x"]\nexcludesfile = /a\n'), undefined);
  // Set to nothing is not unset: it turns global excludes off, git's default included.
  assert.equal(excludesFileOf('[core]\nexcludesfile =\n'), '');
  assert.equal(excludesFileOf('[core]\nexcludesfile = /a\n[core]\nexcludesfile = ""\n'), '');
  // A key can share its line with the section header.
  assert.equal(excludesFileOf('[core] excludesfile = /x\n'), '/x');
  assert.equal(excludesFileOf('[user] excludesfile = /x\n'), undefined);
  // A backslash at the end of a line continues the value; quoted spaces stay.
  assert.equal(excludesFileOf('[core]\nexcludesfile = /a/b\\\nc\n'), '/a/bc');
  assert.equal(excludesFileOf('[core]\nexcludesfile = "/a " \n'), '/a ');
});
