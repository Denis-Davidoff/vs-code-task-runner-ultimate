import { JUST_RECIPE, MAKE_TARGET, SourceKind } from './sources';

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
      return jsonKey(text, ['tasks', name]);
    case 'cargo':
    case 'go':
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
      return taskfileTask(lines, name);
    default:
      return loose(lines, name);
  }
}

// --- JSON --------------------------------------------------------------------

/**
 * The offset of a key at an exact path, found by scanning rather than by
 * re-parsing: `JSON.parse` gives values and no positions, and the file may be
 * JSONC (deno.jsonc), so the scanner skips comments the way `parseJsonc` does.
 *
 * Only keys at the exact depth of the path match, which is what keeps a script
 * called `scripts` from answering for the table that holds it.
 */
function jsonKey(text: string, path: ReadonlyArray<string>): TaskLocation | undefined {
  // One entry per open brace or bracket, holding the key it is the value of —
  // null for the document's own outermost one, and for anything inside an array.
  const stack: Array<string | null> = [];
  let pending: string | null = null;
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
      const after = skipBlanks(text, index);
      if (text[after] !== ':') {
        continue;
      }
      // A key at the right depth whose path matches to the last segment.
      if (stack.length === path.length && path.every((key, at) => (at === path.length - 1 ? key === value.text : stack[at + 1] === key))) {
        return at(text, start, index - start);
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

  return undefined;
}

function readJsonString(text: string, start: number): { text: string; end: number } {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      // Only the escape's own character is consumed: the point is to find the
      // closing quote, not to decode `\u` — a task name needing one is not a
      // name any of these runners can be asked for on a command line.
      value += text[index + 1] ?? '';
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

function skipComment(text: string, index: number): number {
  if (text[index + 1] === '/') {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }
  const end = text.indexOf('*/', index + 2);
  return end < 0 ? text.length : end + 2;
}

function skipBlanks(text: string, index: number): number {
  let at = index;
  while (at < text.length && /\s/.test(text[at])) {
    at++;
  }
  return at;
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

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const header = /^\[\[?\s*(.*?)\s*\]\]?/.exec(trimmed);
    if (header) {
      const keys = tomlKeyPath(header[1]);
      table = keys ?? [];
      if (keys && under(keys, path)) {
        return on(lines, index, key);
      }
      continue;
    }

    const assignment = /^([^=]+?)\s*=/.exec(trimmed);
    const keys = assignment ? tomlKeyPath(assignment[1]) : undefined;
    if (keys && under([...table, ...keys], path)) {
      return on(lines, index, key);
    }
  }

  return undefined;
}

/** `tool.poe."my task"` -> the three keys it names, or undefined if it is not a key path. */
function tomlKeyPath(source: string): string[] | undefined {
  const keys: string[] = [];
  let index = 0;

  for (;;) {
    while (index < source.length && /\s/.test(source[index])) {
      index++;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index++;
      let value = '';
      while (index < source.length && source[index] !== quote) {
        if (quote === '"' && source[index] === '\\') {
          index++;
        }
        value += source[index++];
      }
      index++;
      keys.push(value);
    } else {
      let value = '';
      while (index < source.length && /[A-Za-z0-9_-]/.test(source[index])) {
        value += source[index++];
      }
      if (!value) {
        return undefined;
      }
      keys.push(value);
    }
    while (index < source.length && /\s/.test(source[index])) {
      index++;
    }
    if (source[index] !== '.') {
      return index === source.length ? keys : undefined;
    }
    index++;
  }
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
  const section = lines.findIndex((line) => line.trim().replace(/\s+/g, '') === `[testenv:${name}]`);
  if (section >= 0) {
    return on(lines, section, name);
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
      return on(lines, index, name);
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
    const definition = /^\s*def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (definition) {
      if ((named ?? definition[1]) === name) {
        return on(lines, index, definition[1]);
      }
      armed = false;
      named = undefined;
    }
  }

  return undefined;
}

/** The first target line that names this target, recipe bodies skipped as in the parser. */
function makeTarget(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('\t') || !line.trim() || line.trim().startsWith('#')) {
      continue;
    }
    const match = MAKE_TARGET.exec(line);
    if (match && match[1].trim().split(/\s+/).includes(name)) {
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
 * The key of a task inside the top-level `tasks:` block, located the way
 * `parseTaskfile` reads it: by indentation, since the names are all that is
 * wanted and a YAML parser is not worth shipping for them.
 */
function taskfileTask(lines: ReadonlyArray<string>, name: string): TaskLocation | undefined {
  const start = lines.findIndex((line) => /^tasks:\s*(#.*)?$/.test(line));
  if (start < 0) {
    return undefined;
  }

  let indent: number | undefined;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width === 0) {
      break;
    }
    if (indent === undefined) {
      indent = width;
    }
    if (width > indent) {
      continue;
    }
    const key = /^(.*?):(\s|$)/.exec(line.trim());
    if (key && key[1].trim().replace(/^["']|["']$/g, '') === name) {
      return on(lines, index, name);
    }
  }

  return undefined;
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

/** A location on a line, pointing at the name if it is on it and at the line if it is not. */
function on(lines: ReadonlyArray<string>, line: number, name: string): TaskLocation {
  const character = lines[line]?.indexOf(name) ?? -1;
  return character < 0
    ? { line, character: 0, length: 0 }
    : { line, character, length: name.length };
}

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
