/**
 * A TOML reader for the manifests this extension scans — Cargo.toml,
 * pyproject.toml, Pipfile, Makefile.toml and mise.toml.
 *
 * It is deliberately a subset: tables, arrays of tables, dotted and quoted keys,
 * every string form, arrays, inline tables, numbers and booleans. Dates and
 * times are kept as the raw text, since nothing here ever reads one, and no
 * value is validated beyond what it takes to find the end of it. A manifest that
 * this cannot parse is skipped rather than reported — the file belongs to the
 * project, not to us, and a scan that throws would take the whole list down.
 *
 * Bundling a real parser would mean a runtime dependency in an extension that
 * currently ships with none, for a few hundred lines of reading.
 */
export function parseToml(text: string): Record<string, unknown> | undefined {
  try {
    return new Reader(text).document();
  } catch {
    return undefined;
  }
}

/** Reads `table.of[0].keys` out of a parsed document, tolerating anything missing. */
export function tomlTable(root: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let node: unknown = root;
  for (const key of keys) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === 'object' && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : undefined;
}

/** An array-of-tables value, as `[[bin]]` produces. A lone table counts as one entry. */
export function tomlTables(root: unknown, ...keys: string[]): Record<string, unknown>[] {
  let node: unknown = root;
  for (const key of keys) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return [];
    }
    node = (node as Record<string, unknown>)[key];
  }
  const list = Array.isArray(node) ? node : [node];
  return list.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const NUMBER = /^[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9_]+)?)$/;

class Reader {
  private index = 0;

  constructor(private readonly text: string) {}

  document(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let table = root;

    for (;;) {
      this.trivia();
      if (this.done()) {
        return root;
      }

      if (this.char() === '[') {
        this.index++;
        const arrayOfTables = this.char() === '[';
        if (arrayOfTables) {
          this.index++;
        }
        const keys = this.keyPath();
        this.expect(']');
        if (arrayOfTables) {
          this.expect(']');
        }
        table = arrayOfTables ? pushTable(root, keys) : openTable(root, keys);
        continue;
      }

      const keys = this.keyPath();
      this.expect('=');
      assign(table, keys, this.value());
    }
  }

  // --- cursor ---------------------------------------------------------------

  private done(): boolean {
    return this.index >= this.text.length;
  }

  private char(): string {
    return this.text[this.index] ?? '';
  }

  /** Spaces and tabs only — a newline ends a key/value pair. */
  private blank(): void {
    while (this.char() === ' ' || this.char() === '\t') {
      this.index++;
    }
  }

  /** Whitespace of any kind, plus comments. */
  private trivia(): void {
    for (;;) {
      const char = this.char();
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        this.index++;
      } else if (char === '#') {
        while (!this.done() && this.char() !== '\n') {
          this.index++;
        }
      } else {
        return;
      }
    }
  }

  private expect(char: string): void {
    this.blank();
    if (this.char() !== char) {
      throw new Error(`expected ${char}`);
    }
    this.index++;
  }

  // --- keys -----------------------------------------------------------------

  private keyPath(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.blank();
      keys.push(this.key());
      this.blank();
      if (this.char() !== '.') {
        return keys;
      }
      this.index++;
    }
  }

  private key(): string {
    if (this.char() === '"') {
      return this.basicString();
    }
    if (this.char() === "'") {
      return this.literalString();
    }
    const start = this.index;
    while (BARE_KEY.test(this.char())) {
      this.index++;
    }
    if (this.index === start) {
      throw new Error('empty key');
    }
    return this.text.slice(start, this.index);
  }

  // --- values ---------------------------------------------------------------

  private value(): unknown {
    this.blank();
    const char = this.char();
    if (char === '"') {
      return this.text.startsWith('"""', this.index) ? this.multiline('"""') : this.basicString();
    }
    if (char === "'") {
      return this.text.startsWith("'''", this.index) ? this.multiline("'''") : this.literalString();
    }
    if (char === '[') {
      return this.array();
    }
    if (char === '{') {
      return this.inlineTable();
    }
    return this.bare();
  }

  private array(): unknown[] {
    this.index++;
    const items: unknown[] = [];
    for (;;) {
      this.trivia();
      if (this.done()) {
        throw new Error('unterminated array');
      }
      if (this.char() === ']') {
        this.index++;
        return items;
      }
      items.push(this.value());
      this.trivia();
      if (this.char() === ',') {
        this.index++;
      } else if (this.char() !== ']') {
        throw new Error('malformed array');
      }
    }
  }

  private inlineTable(): Record<string, unknown> {
    this.index++;
    const table: Record<string, unknown> = {};
    for (;;) {
      this.trivia();
      if (this.done()) {
        throw new Error('unterminated table');
      }
      if (this.char() === '}') {
        this.index++;
        return table;
      }
      const keys = this.keyPath();
      this.expect('=');
      assign(table, keys, this.value());
      this.trivia();
      if (this.char() === ',') {
        this.index++;
      } else if (this.char() !== '}') {
        throw new Error('malformed table');
      }
    }
  }

  /** Numbers, booleans and anything else that ends at a delimiter — dates included. */
  private bare(): unknown {
    const start = this.index;
    while (!this.done() && !',]}#\n\r'.includes(this.char())) {
      this.index++;
    }
    const raw = this.text.slice(start, this.index).trim();
    if (raw === 'true' || raw === 'false') {
      return raw === 'true';
    }
    if (NUMBER.test(raw)) {
      return Number(raw.replace(/_/g, ''));
    }
    if (raw === '') {
      throw new Error('missing value');
    }
    return raw;
  }

  // --- strings --------------------------------------------------------------

  private basicString(): string {
    this.index++;
    let out = '';
    for (;;) {
      if (this.done() || this.char() === '\n') {
        throw new Error('unterminated string');
      }
      const char = this.char();
      this.index++;
      if (char === '"') {
        return out;
      }
      out += char === '\\' ? this.escape() : char;
    }
  }

  private literalString(): string {
    this.index++;
    const end = this.text.indexOf("'", this.index);
    const stop = this.text.indexOf('\n', this.index);
    if (end < 0 || (stop >= 0 && stop < end)) {
      throw new Error('unterminated string');
    }
    const out = this.text.slice(this.index, end);
    this.index = end + 1;
    return out;
  }

  private multiline(delimiter: string): string {
    this.index += 3;
    // A newline straight after the opening delimiter is not part of the value.
    if (this.text.startsWith('\r\n', this.index)) {
      this.index += 2;
    } else if (this.char() === '\n') {
      this.index++;
    }

    const literal = delimiter === "'''";
    let out = '';
    for (;;) {
      if (this.done()) {
        throw new Error('unterminated string');
      }
      if (this.text.startsWith(delimiter, this.index)) {
        this.index += 3;
        return out;
      }
      const char = this.char();
      this.index++;
      if (literal || char !== '\\') {
        out += char;
        continue;
      }
      // A backslash at the end of a line swallows the newline and the indent
      // that follows it, which is how long commands are wrapped in a manifest.
      if (this.char() === '\n' || this.text.startsWith('\r\n', this.index)) {
        while (' \t\r\n'.includes(this.char()) && !this.done()) {
          this.index++;
        }
        continue;
      }
      out += this.escape();
    }
  }

  private escape(): string {
    const char = this.char();
    this.index++;
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '0':
        return '\0';
      case 'u':
      case 'U': {
        const width = char === 'u' ? 4 : 8;
        const code = parseInt(this.text.slice(this.index, this.index + width), 16);
        this.index += width;
        return Number.isNaN(code) ? '' : String.fromCodePoint(code);
      }
      default:
        return char;
    }
  }
}

// --- shaping the document ----------------------------------------------------

/** Walks to the table a dotted key writes into, following the last entry of any array of tables. */
function descend(table: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let node = table;
  for (const key of keys) {
    const next = node[key];
    if (Array.isArray(next) && next.length > 0 && typeof next[next.length - 1] === 'object') {
      node = next[next.length - 1] as Record<string, unknown>;
    } else if (next && typeof next === 'object' && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  return node;
}

function assign(table: Record<string, unknown>, keys: string[], value: unknown): void {
  descend(table, keys.slice(0, -1))[keys[keys.length - 1]] = value;
}

function openTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return descend(root, keys);
}

function pushTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const parent = descend(root, keys.slice(0, -1));
  const key = keys[keys.length - 1];
  const existing = parent[key];
  const list = Array.isArray(existing) ? existing : [];
  parent[key] = list;
  const entry: Record<string, unknown> = {};
  list.push(entry);
  return entry;
}
