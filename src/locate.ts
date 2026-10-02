import { DOCKERFILE_STAGE, expandBraces, JUST_RECIPE, MAKE_TARGET, makeDefineLines, SourceKind, yamlBlockKeys } from './sources';
import { readTomlKeyPath, TomlKey } from './toml';

/**
 * Where a task is written down in its manifest: a zero-based line, and the span
 * of the task's name on it so the editor can select the name rather than drop
 * the cursor in column zero.
 */
export interface TaskLocation {
  line: number;
  character: number;
  length: number;
}

/**
 * Finds the line a task is defined on, given the manifest's text.
 *
 * This is a second, lazy pass over a file the scan has already parsed, rather
 * than a line number carried on every `ScriptEntry`: a position is wanted for
 * the one row the user clicked, and threading one out of fourteen parsers —
 * two of which do not read the file line by line at all — would cost every
 * scan of every manifest in the workspace to serve that one click.
 *
 * Each branch below mirrors the parser in `sources.ts` that produced the name,
 * so the row and the line it opens agree on what the task is. Where a parser
 * derives its rows instead of reading them — cargo and go, whose tasks are
 * subcommands and not entries in the file — there is nothing to point at and
 * the caller opens the manifest at the top.
 */
export function locateTask(text: string, kind: SourceKind, name: string): TaskLocation | undefined {
  const lines = text.split(/\r?\n/);

  switch (kind) {
    case 'npm':
    case 'composer':
      return jsonKey(text, ['scripts', name]);
    case 'deno':
    // The custom tasks file is laid out the way deno.json is: one `tasks` object,
    // name to command.
    case 'custom':
      return jsonKey(text, ['tasks', name]);
    case 'cargo':
    case 'go':
    // A compose row is a subcommand, not an entry anyone wrote — and the shell
    // rows name a file rather than a line inside one, which the caller opens
    // directly. Both are spelled out rather than left to the `default:` below,
    // which would hand them to `loose` and point the editor at a wrong line.
    case 'docker-compose':
    case 'shell':
      return undefined;
    case 'cargo-make':
    case 'mise':
      return tomlKey(lines, [{ table: ['tasks'], key: name }]);
    case 'pipfile':
      return tomlKey(lines, [{ table: ['scripts'], key: name }]);
    case 'pyproject':
      return tomlKey(lines, pyprojectTables(name)) ?? loose(lines, name);
    case 'tox':
      return toxEnvironment(lines, name);
    case 'nox':
      return noxSession(lines, name);
    case 'make':
      return makeTarget(lines, name);
    case 'just':
      return justRecipe(lines, name);
    case 'taskfile':
      return yamlKey(lines, 'tasks', name);
    case 'dockerfile':
      return dockerfileStage(lines, name);
    default:
      return loose(lines, name);
  }
}

// --- Dockerfile --------------------------------------------------------------

/**
 * The `FROM … AS <stage>` line a `build: <stage>` row was derived from.
 *
 * The one row in a Dockerfile group that points at anything: `build`, `run` and
 * whatever `dockerfileCommands` adds are subcommands nobody wrote down, so those
 * open the file at the top like cargo's and compose's do.
 *
 * The stage name is selected rather than the line, which is why the column is
 * measured off the match: it is the word a rename would have to touch.
 */
function dockerfileStage(lines: string[], name: string): TaskLocation | undefined {
  const at = name.indexOf('build: ');
  if (at !== 0) {
    return undefined;
  }
  const stage = name.slice('build: '.length);
  for (let line = 0; line < lines.length; line++) {
    const found = DOCKERFILE_STAGE.exec(lines[line]);
    if (found?.[1] === stage) {
      // `lastIndexOf` rather than `indexOf`: a stage is very often named after
      // the image it is built from — `FROM builder AS builder` — and the first
      // occurrence there is the wrong half of the line.
      return { line, character: lines[line].lastIndexOf(stage), length: stage.length };
    }
  }
  return undefined;
}

// --- JSON --------------------------------------------------------------------

/**
 * The offset of a key at an exact path, found by scanning rather than by
 * re-parsing: `JSON.parse` gives values and no positions, and the file may be
 * JSONC (deno.jsonc), so the scanner skips comments the way `parseJsonc` does.
 *
 * Only keys at the exact depth of the path match, which is what keeps a script
 * called `scripts` from answering for the table that holds it.
 *
 * A duplicated key is answered by its last occurrence, because that is the one
 * `JSON.parse` keeps and so the one the row runs. The same goes for the tables
 * above it: a second `"scripts"` replaces the first whole, and a key found in
 * the first is forgotten when it opens.
 */
function jsonKey(text: string, path: ReadonlyArray<string>): TaskLocation | undefined {
  // One entry per open brace or bracket, holding the key it is the value of —
  // null for the document's own outermost one, and for anything inside an array.
  const stack: Array<string | null> = [];
  let pending: string | null = null;
  let found: TaskLocation | undefined;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipComment(text, index);
      continue;
    }
    if (char === '"') {
      const start = index;
      const value = readJsonString(text, index);
      index = value.end;
      // JSONC lets a comment sit between a key and its colon — `"tasks" /* … */ :`
      // is as much a key as `"tasks":`, and `parseJsonc` reads it as one.
      const after = skipBlanksAndComments(text, index);
      if (text[after] !== ':') {
        continue;
      }
      // A key whose path matches the path's own up to its depth: the task itself
      // at the full depth, one of the tables holding it above that.
      const depth = stack.length;
      if (
        depth >= 1 &&
        depth <= path.length &&
        value.text === path[depth - 1] &&
        path.slice(0, depth - 1).every((key, at) => stack[at + 1] === key)
      ) {
        // The name without its quotes, as every other locator selects it.
        found = depth === path.length ? at(text, start + 1, index - start - 2) : undefined;
      }
      pending = value.text;
      index = after + 1;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(pending);
      pending = null;
    } else if (char === '}' || char === ']') {
      stack.pop();
      pending = null;
    } else if (char === ',') {
      pending = null;
    }
    index++;
  }

  return found;
}

function readJsonString(text: string, start: number): { text: string; end: number } {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      // Decoded the way `JSON.parse` decodes it, since that is how the parser
      // read the name this is asked to find: `"bui\u006cd"` is the key `build`.
      const next = text[index + 1] ?? '';
      if (next === 'u') {
        const hex = text.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += String.fromCharCode(parseInt(hex, 16));
          index += 6;
          continue;
        }
      }
      value += JSON_ESCAPES[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') {
      return { text: value, end: index + 1 };
    }
    value += char;
    index++;
  }
  return { text: value, end: index };
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function skipComment(text: string, index: number): number {
  if (text[index + 1] === '/') {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }
  const end = text.indexOf('*/', index + 2);
  return end < 0 ? text.length : end + 2;
}

function skipBlanksAndComments(text: string, index: number): number {
  let at = index;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) {
      at++;
    }
    if (text[at] === '/' && (text[at + 1] === '/' || text[at + 1] === '*')) {
      at = skipComment(text, at);
      continue;
    }
    return at;
  }
}

// --- TOML --------------------------------------------------------------------

/** A task table and the key inside it that a name is written as. */
interface TomlTarget {
  table: string[];
  key: string;
}

/**
 * The tables pyproject.toml can hold a task in, in the order `parsePyproject`
 * reads them — the first one that has the name is the one the row came from,
 * because that parser keeps the first of any duplicate name too.
 *
 * Hatch is the one runner whose task names are composed: every environment has
 * its own script table, and a script outside the default one is addressed as
 * `env:script`, so the name is split back apart to find it.
 */
function pyprojectTables(name: string): TomlTarget[] {
  const targets: TomlTarget[] = [
    { table: ['tool', 'poetry', 'scripts'], key: name },
    { table: ['tool', 'pdm', 'scripts'], key: name },
    { table: ['tool', 'rye', 'scripts'], key: name },
    { table: ['tool', 'poe', 'tasks'], key: name },
    { table: ['tool', 'hatch', 'envs', 'default', 'scripts'], key: name },
  ];
  const colon = name.indexOf(':');
  if (colon > 0) {
    targets.push({
      table: ['tool', 'hatch', 'envs', name.slice(0, colon), 'scripts'],
      key: name.slice(colon + 1),
    });
  }
  targets.push({ table: ['project', 'scripts'], key: name });
  return targets;
}

/**
 * The line a key is written on, for any of the given tables. A task can be
 * spelled as a value inside its table (`build = "cargo build"`), as a table of
 * its own (`[tasks.build]`), or as a dotted key from anywhere above it
 * (`tasks.build.run = …`) — all three end at the same path, so the path is what
 * is matched and not the syntax.
 */
function tomlKey(lines: ReadonlyArray<string>, targets: ReadonlyArray<TomlTarget>): TaskLocation | undefined {
  for (const target of targets) {
    const found = tomlPath(lines, [...target.table, target.key], target.key);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function tomlPath(lines: ReadonlyArray<string>, path: string[], key: string): TaskLocation | undefined {
  let table: string[] = [];
  // The multiline string a line opens inside of, if any. A help text that
  // quotes `[tasks.build]` on a line of its own is not the table, and the
  // parser, which reads strings whole, never took it for one.
  let open: MultilineQuote | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const inside = open !== undefined;
    open = multilineAfter(line, open);
    const trimmed = line.trim();
    if (inside || !trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Read with the parser's own key reader rather than a pattern: a quoted key
    // may hold a `]`, an `=` or a `\u` escape, and only reading it the way
    // `parseToml` did finds the same keys in it.
    const first = line.length - line.trimStart().length;
    if (line[first] === '[') {
      const open = line[first + 1] === '[' ? first + 2 : first + 1;
      const header = readTomlKeyPath(line, open);
      const keys = header && line.slice(header.end).startsWith(']') ? header.keys : undefined;
      table = keys?.map((each) => each.key) ?? [];
      if (keys && under(table, path)) {
        return onKey(lines, index, keys[path.length - 1], key);
      }
      continue;
    }

    const assignment = readTomlKeyPath(line, first);
    if (!assignment || line[assignment.end] !== '=') {
      continue;
    }
    const keys = assignment.keys;
    if (under([...table, ...keys.map((each) => each.key)], path)) {
      return onKey(lines, index, keys[path.length - 1 - table.length], key);
    }
  }

  return undefined;
}

/** The span a key was written as, when the path's last key is on this line. */
function onKey(lines: ReadonlyArray<string>, line: number, written: TomlKey | undefined, name: string): TaskLocation {
  return written ? { line, character: written.start, length: written.end - written.start } : on(lines, line, name);
}

type MultilineQuote = '"""' | "'''";

/**
 * The multiline string still open at the end of a line, given the one open at
 * its start. Single-line strings and comments are walked over only so that a
 * `"""` inside them, or after a `#`, is not taken for an opener.
 */
function multilineAfter(line: string, open: MultilineQuote | undefined): MultilineQuote | undefined {
  let index = 0;
  let quote = open;

  while (index < line.length) {
    if (quote) {
      if (quote === '"""' && line[index] === '\\') {
        index += 2;
        continue;
      }
      if (line.startsWith(quote, index)) {
        // A run of quotes at the end closes on its last three, so `"""a""""`
        // holds `a"` — the extra ones belong to the string, not a new opener.
        index += 3;
        while (index < line.length && line[index] === quote[0]) {
          index++;
        }
        quote = undefined;
        continue;
      }
      index++;
      continue;
    }

    const char = line[index];
    if (char === '#') {
      return undefined;
    }
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      quote = line.slice(index, index + 3) as MultilineQuote;
      index += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      index++;
      while (index < line.length && line[index] !== char) {
        index += char === '"' && line[index] === '\\' ? 2 : 1;
      }
      index++;
      continue;
    }
    index++;
  }

  return quote;
}

/** True when `keys` is the path itself or something nested inside it. */
function under(keys: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return keys.length >= path.length && path.every((key, index) => keys[index] === key);
}

// --- line-oriented formats ---------------------------------------------------

/**
 * tox names an environment twice over: in the `envlist` of `[tox]` and, when it
 * has settings of its own, as a `[testenv:name]` section. The section is the
 * definition worth opening, and the envlist entry is where an environment that
 * has no section is written.
 */
function toxEnvironment(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  // The header as written, or one whose braces open into the name — which is
  // how `parseTox` got `lint` out of `[testenv:{lint,format}]`.
  const header = (line: string) => /^\[testenv:(.*)\]$/.exec(line.trim().replace(/\s+/g, ''))?.[1];
  const exact = lines.findIndex((line) => header(line) === name);
  const section =
    exact >= 0 ? exact : lines.findIndex((line) => expandBraces(header(line) ?? '').includes(name));
  if (section >= 0) {
    // Not `on()`: for a name like `test` or `env` a plain indexOf lands inside
    // the `testenv` prefix, so the search starts after the colon.
    const line = lines[section];
    const character = line.indexOf(name, line.indexOf(':') + 1);
    return character < 0
      ? { line: section, character: 0, length: 0 }
      : { line: section, character, length: name.length };
  }

  let inTox = false;
  let inList = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const header = /^\[(.*)\]/.exec(line.trim());
    if (header) {
      inTox = header[1].trim() === 'tox';
      inList = false;
      continue;
    }
    if (!inTox) {
      continue;
    }
    // An envlist runs over as many indented lines as it likes, so the search
    // stays open until the next option starts.
    if (/^(envlist|env_list)\s*=/.test(line.trim())) {
      inList = true;
    } else if (inList && /^[A-Za-z_]\w*\s*=/.test(line)) {
      inList = false;
    }
    if (inList && entryOf(line).includes(name)) {
      // The same trap as the section header: a plain indexOf would find `test`
      // inside `latest`, so the match is anchored to entry boundaries.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|[=,\\s])(${escaped})(?=$|[,\\s])`).exec(line);
      return match
        ? { line: index, character: match.index + match[0].length - name.length, length: name.length }
        : on(lines, index, name);
    }
  }

  return undefined;
}

/** The comma- or whitespace-separated names on one line of an envlist. */
function entryOf(line: string): string[] {
  return line
    .replace(/^[^=]*=/, '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A nox session is a decorated function, and the decorator may rename it, so
 * the file is walked the way `parseNoxfile` walks it and the `def` line of the
 * matching session is what comes back.
 */
function noxSession(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  let armed = false;
  let named: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*@(nox\.)?session\b/.test(line)) {
      armed = true;
    }
    if (!armed) {
      continue;
    }
    const explicit = /\bname\s*=\s*["']([^"']+)["']/.exec(line);
    if (explicit) {
      named = explicit[1];
    }
    const definition = /^(\s*def\s+)([A-Za-z_]\w*)\s*\(/.exec(line);
    if (definition) {
      if ((named ?? definition[2]) === name) {
        // The function's name, measured off the match: `def e(…)` has an `e` in
        // `def` first.
        return { line: index, character: definition[1].length, length: definition[2].length };
      }
      armed = false;
      named = undefined;
    }
  }

  return undefined;
}

/** The first target line that names this target, recipe bodies skipped as in the parser. */
function makeTarget(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  const defined = makeDefineLines(lines);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('\t') || !line.trim() || line.trim().startsWith('#') || defined[index]) {
      continue;
    }
    const match = MAKE_TARGET.exec(line);
    if (match && match[1].trim().split(/\s+/).includes(name)) {
      // The target as a whole word of the target list, not the first place its
      // text appears: `all a:` has an `a` in `all`, and `a.o a:` one in `a.o`.
      for (const word of match[1].matchAll(/\S+/g)) {
        if (word[0] === name) {
          return { line: index, character: word.index ?? 0, length: name.length };
        }
      }
      return on(lines, index, name);
    }
  }
  return undefined;
}

function justRecipe(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s/.test(line) || line.startsWith('#') || line.startsWith('[')) {
      continue;
    }
    const match = JUST_RECIPE.exec(line);
    if (match && match[1] === name) {
      return on(lines, index, name);
    }
  }
  return undefined;
}

/**
 * The key of an entry inside a named top-level block — go-task's `tasks:`, and
 * whatever else comes to want one. It is `yamlBlockKeys` itself that does the
 * walking, so the line this opens is found by the same rule that put the name in
 * the list rather than by a second reading of the same indentation.
 */
function yamlKey(
  lines: ReadonlyArray<string>,
  block: string,
  name: string,
): TaskLocation | undefined {
  const found = yamlBlockKeys(lines, block).find((entry) => entry.name === name);
  return found ? on(lines, found.line, name) : undefined;
}

/**
 * Last resort for a name written in a shape none of the readers above expect —
 * an inline table, a flow-style mapping. It looks for the name in the one
 * position that means "this is defined here": followed by a colon or an equals
 * sign, which covers every format in this file.
 */
function loose(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[\\s{,])["']?${quoted}["']?\\s*[:=]`);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : on(lines, index, name);
}

// --- positions ---------------------------------------------------------------

/**
 * A location on a line, pointing at the name if it is on it and at the line if
 * it is not.
 *
 * The name as a word of its own where it is one: a short name is very often a
 * piece of something else on the same line — the `a` in `tasks` before
 * `tasks.a`, the `e` in `def` — and the first place its text turns up is then
 * not the key. Only when it appears nowhere on its own does the first
 * occurrence do.
 */
function on(lines: ReadonlyArray<string>, line: number, name: string): TaskLocation {
  const text = lines[line] ?? '';
  let character = -1;
  if (name) {
    for (let from = text.indexOf(name); from >= 0; from = text.indexOf(name, from + 1)) {
      if (!NAME_CHAR.test(text[from - 1] ?? '') && !NAME_CHAR.test(text[from + name.length] ?? '')) {
        character = from;
        break;
      }
    }
    if (character < 0) {
      character = text.indexOf(name);
    }
  }
  return character < 0
    ? { line, character: 0, length: 0 }
    : { line, character, length: name.length };
}

/** What a name runs on through: next to one of these, it is part of a longer word. */
const NAME_CHAR = /[A-Za-z0-9_-]/;

/** The same, from an offset into the whole text. */
function at(text: string, offset: number, length: number): TaskLocation {
  let line = 0;
  let start = 0;
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\n') {
      line++;
      start = index + 1;
    }
  }
  return { line, character: offset - start, length };
}
