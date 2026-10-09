/**
 * git's ignore rules — `.gitignore`, `.git/info/exclude` and the global excludes
 * file — read the way git reads them, so that a manifest git leaves out of the
 * repository is left out of the list too.
 *
 * The case this exists for is a coding agent's scratch checkout: Claude Code
 * puts each subagent's git worktree in `.claude/worktrees/<name>`, a full copy
 * of the repository with every package.json in it, and writes that directory
 * into `.git/info/exclude` rather than into any `.gitignore`. Each one doubled
 * the list until it was deleted.
 *
 * Matched here rather than asked of `git check-ignore`: a scan never starts a
 * process, and over Remote SSH one per manifest would be a round trip each.
 * Rather than bundled, for the same reason the TOML reader is: the extension
 * ships with no runtime dependency, for a few hundred lines.
 *
 * The matcher is git's own `wildmatch`, carried over step for step, and not a
 * translation into regular expressions. The first version was one, and a line
 * of a dozen `**` segments in a cloned repository's `.gitignore` held the
 * extension host for seconds per path while git answered in milliseconds:
 * a backtracking regex retries every split of the path, where `wildmatch` gives
 * up on a whole branch the moment the text runs out. Matching git step for step
 * also settles the corners a translation gets wrong — brackets, escapes, `***`.
 *
 * Paths are URI paths — forward slashes, absolute — and so are the bases the
 * rules are relative to. Nothing here touches the disk; `sources.ts` reads the
 * files and decides which of them are in force where.
 */

/** One pattern line, read. */
export interface IgnoreRule {
  /** `!` in front: a match brings the path back rather than leaving it out. */
  negated: boolean;
  /** `/` behind: the pattern matches a directory and never a file. */
  directoryOnly: boolean;
  /**
   * A slash at the start or in the middle: the pattern is matched against the
   * whole path below its file's directory. Without one it is matched against
   * the name alone, and so at any depth.
   */
  anchored: boolean;
  /**
   * The path this rule names at the top of its file's directory, when it names
   * one in plain text: the pattern without its `!`, the slashes at either end
   * and a leading `**` segment, holding no wildcard and no escape. The rule
   * matches that path; an unanchored one, or one led by `**`, deeper too.
   */
  literal?: string;
  /** The pattern git matches, leading slash gone, as UTF-8 bytes — see `bytes`. */
  pattern: string;
  /** How much of `pattern` comes before its first wildcard or escape. */
  plain: number;
  ignoreCase: boolean;
}

/** The rules of one ignore file, and the directory they are relative to. */
export interface IgnoreFile {
  /** A URI path with no trailing slash. */
  base: string;
  rules: IgnoreRule[];
}

/**
 * Every pattern in an ignore file, in the order they were written.
 *
 * `ignoreCase` is git's `core.ignorecase`, which `git init` turns on wherever
 * the file system cannot tell `Build` from `build` — macOS and Windows, as they
 * ship. Only ASCII letters fold, as in git.
 */
export function parseIgnore(text: string, ignoreCase = false): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  // Lines end at `\n`, and a `\r` before one goes with it — including on the
  // last line, which git reads as though the newline were there.
  for (const line of text.split('\n')) {
    const rule = parseLine(line.endsWith('\r') ? line.slice(0, -1) : line, ignoreCase);
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

/**
 * Whether these files leave `target` out, read in the order given — lowest
 * precedence first, so the global file, then `info/exclude`, then each
 * `.gitignore` from the top down — with the last pattern that matches deciding,
 * exactly as git does.
 *
 * This is the verdict on the path itself. Git also never looks inside a
 * directory it ignores, so a `!` cannot bring back a file below one; that half
 * is the caller's, which asks about each directory on the way down first.
 */
export function ignoredBy(files: ReadonlyArray<IgnoreFile>, target: string, directory: boolean): boolean {
  // From the last pattern back, so the first match is the one that decides.
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index];
    const prefix = file.base.endsWith('/') ? file.base : `${file.base}/`;
    if (!target.startsWith(prefix) || target.length === prefix.length) {
      continue;
    }
    const relative = bytes(target.slice(prefix.length));
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    for (let at = file.rules.length - 1; at >= 0; at -= 1) {
      const rule = file.rules[at];
      if ((directory || !rule.directoryOnly) && matches(rule, rule.anchored ? relative : name)) {
        return !rule.negated;
      }
    }
  }
  return false;
}

/**
 * `core.excludesFile` as a git config file sets it, the last one winning: the
 * path, `''` when it is set to nothing — which turns global excludes off,
 * git's default file included — or undefined when it is not set at all.
 * `[include]` and `[includeIf]` are not followed: a global excludes file named
 * only inside an included config is not read.
 */
export function excludesFileOf(config: string): string | undefined {
  let inCore = false;
  let found: string | undefined;
  // A backslash at the very end of a line carries the value on to the next.
  const joined = config.replace(/(^|[^\\])((?:\\\\)*)\\\r?\n/g, '$1$2');
  for (const raw of joined.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith('[')) {
      const close = sectionEnd(line);
      // `[core "x"]` is a subsection, and not where this key lives.
      inCore = close !== -1 && /^\[\s*core\s*\]$/i.test(line.slice(0, close + 1));
      // A key can follow its section on the same line: `[core] excludesFile = …`.
      line = close === -1 ? '' : line.slice(close + 1).trim();
    }
    const match = inCore ? /^excludesfile\s*=(.*)$/i.exec(line) : null;
    if (match) {
      found = configValue(match[1]);
    }
  }
  return found;
}

/** Where a section header's `]` is, past any quoted subsection name; -1 when it never closes. */
function sectionEnd(line: string): number {
  let quoted = false;
  for (let at = 1; at < line.length; at += 1) {
    if (line[at] === '\\' && quoted) {
      at += 1;
    } else if (line[at] === '"') {
      quoted = !quoted;
    } else if (line[at] === ']' && !quoted) {
      return at;
    }
  }
  return -1;
}

/**
 * A config value as git reads it: quotes and escapes taken out, a `#` or `;`
 * outside quotes ending it, and the whitespace at either end dropped unless it
 * was quoted.
 */
function configValue(raw: string): string {
  const escapes: Readonly<Record<string, string>> = { t: '\t', n: '\n', b: '\b' };
  let out = '';
  // `out` up to its last character that is not unquoted whitespace.
  let kept = 0;
  let quoted = false;
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at];
    if (char === '\\' && at + 1 < raw.length) {
      at += 1;
      out += Object.prototype.hasOwnProperty.call(escapes, raw[at]) ? escapes[raw[at]] : raw[at];
      kept = out.length;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === '#' || char === ';')) {
      break;
    } else if (!quoted && /\s/.test(char)) {
      if (out.length > 0) {
        out += char;
      }
    } else {
      out += char;
      kept = out.length;
    }
  }
  return out.slice(0, kept);
}

/** The characters git's matcher treats as anything but themselves. */
const GLOB_SPECIAL = /[*?[\\]/;

function parseLine(raw: string, ignoreCase: boolean): IgnoreRule | undefined {
  // A comment is a `#` in the first column only; `\#` is how a name starts with one.
  if (raw.startsWith('#')) {
    return undefined;
  }
  let line = trimTrailingSpaces(raw);
  const negated = line.startsWith('!');
  if (negated) {
    line = line.slice(1);
  }
  const directoryOnly = line.endsWith('/');
  if (directoryOnly) {
    line = line.slice(0, -1);
  }
  // Any slash left — an escaped one too, as git counts them — anchors it.
  const anchored = line.includes('/');
  if (line.startsWith('/')) {
    line = line.slice(1);
  }
  // A lone `/` or `!` is a pattern of nothing, which git matches against nothing.
  if (line === '') {
    return undefined;
  }
  const plainText = line.startsWith('**/') ? line.slice(3) : line;
  const pattern = bytes(line);
  const special = GLOB_SPECIAL.exec(pattern);
  return {
    negated,
    directoryOnly,
    anchored,
    literal: plainText && !GLOB_SPECIAL.test(plainText) ? plainText : undefined,
    pattern,
    plain: special ? special.index : pattern.length,
    ignoreCase,
  };
}

/** Trailing spaces go, unless a backslash escapes the last of them — git's `trim_trailing_spaces`. */
function trimTrailingSpaces(line: string): string {
  let lastSpace = -1;
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === ' ') {
      if (lastSpace === -1) {
        lastSpace = at;
      }
    } else if (line[at] === '\\') {
      at += 1;
      if (at >= line.length) {
        return line;
      }
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace === -1 ? line : line.slice(0, lastSpace);
}

/**
 * The text as its UTF-8 bytes, one per character of the result. Git compares
 * bytes: `?` is one byte, so it does not stand for an `é`, and only ASCII
 * letters fold under `ignoreCase`.
 */
function bytes(text: string): string {
  // Nearly every path is ASCII, which is already its own bytes.
  if (!/[^\x00-\x7f]/.test(text)) {
    return text;
  }
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out += char;
    } else if (code < 0x800) {
      out += String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out += String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out += String.fromCharCode(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

/**
 * Whether one rule matches — the name alone for an unanchored rule, the path
 * below the file's directory for an anchored one — the way git's
 * `match_basename` and `match_pathname` ask it.
 */
function matches(rule: IgnoreRule, text: string): boolean {
  const { pattern, plain, ignoreCase } = rule;
  if (!rule.anchored) {
    return wildmatch(pattern, text, false, ignoreCase);
  }
  // The part before the first wildcard is compared as text first, which is
  // also how git turns a path away early.
  if (plain > 0) {
    if (plain > text.length || !sameBytes(pattern, text, plain, ignoreCase)) {
      return false;
    }
    if (plain === pattern.length) {
      return plain === text.length;
    }
  }
  return wildmatch(pattern, text, true, ignoreCase);
}

/** The first `length` bytes of each, compared as git's `strncasecmp` does under `ignoreCase`. */
function sameBytes(left: string, right: string, length: number, ignoreCase: boolean): boolean {
  for (let at = 0; at < length; at += 1) {
    if (fold(left.charCodeAt(at), ignoreCase) !== fold(right.charCodeAt(at), ignoreCase)) {
      return false;
    }
  }
  return true;
}

const MATCH = 0;
const NO_MATCH = 1;
/** The text ran out: no later split of it can match either. */
const ABORT_ALL = -1;
/** A `*` met a slash it cannot cross: only a `**` further out can still try. */
const ABORT_TO_STARSTAR = -2;

const NUL = 0;
const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN = 0x5b;
const CLOSE = 0x5d;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const BANG = 0x21;
const CARET = 0x5e;
const DASH = 0x2d;
const COLON = 0x3a;

/** An ASCII capital as its small letter, when folding; every other byte as it is. */
function fold(code: number, ignoreCase: boolean): number {
  return ignoreCase && code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

const isLower = (code: number) => code >= 0x61 && code <= 0x7a;
const isUpper = (code: number) => code >= 0x41 && code <= 0x5a;
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isAlpha = (code: number) => isLower(code) || isUpper(code);
const isAlnum = (code: number) => isAlpha(code) || isDigit(code);
const isGraph = (code: number) => code >= 0x21 && code <= 0x7e;

/** The POSIX classes a bracket expression can name, ASCII only as in git. Any other name matches nothing. */
const CHARACTER_CLASSES: Readonly<Record<string, (code: number) => boolean>> = {
  alnum: isAlnum,
  alpha: isAlpha,
  blank: (code) => code === 0x20 || code === 0x09,
  cntrl: (code) => code < 0x20 || code === 0x7f,
  digit: isDigit,
  graph: isGraph,
  lower: isLower,
  print: (code) => code >= 0x20 && code <= 0x7e,
  punct: (code) => isGraph(code) && !isAlnum(code),
  space: (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d,
  upper: isUpper,
  xdigit: (code) => isDigit(code) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46),
};

/**
 * git's `wildmatch`, `dowild` included, over byte strings. `pathname` is
 * `WM_PATHNAME` — wildcards other than a `**` segment stop at a slash — and
 * `ignoreCase` is `WM_CASEFOLD`.
 *
 * One addition: what each (pattern, text) position answered is remembered. The
 * answer depends on nothing else, so this changes no result; it is what keeps a
 * run of `**` segments, each of which tries the rest of the pattern twice, from
 * costing twice as much per segment — which git itself pays.
 */
function wildmatch(pattern: string, text: string, pathname: boolean, ignoreCase: boolean): boolean {
  const memo = new Map<number, number>();
  const width = text.length + 1;
  const p = (at: number) => (at < pattern.length ? pattern.charCodeAt(at) : NUL);
  const t = (at: number) => (at < text.length ? text.charCodeAt(at) : NUL);

  const dowild = (start: number, from: number): number => {
    const key = start * width + from;
    let answer = memo.get(key);
    if (answer === undefined) {
      answer = run(start, from);
      memo.set(key, answer);
    }
    return answer;
  };

  const run = (start: number, from: number): number => {
    let at = start;
    let to = from;
    for (; p(at) !== NUL; to += 1, at += 1) {
      let tCh = t(to);
      if (tCh === NUL && p(at) !== STAR) {
        return ABORT_ALL;
      }
      tCh = fold(tCh, ignoreCase);
      let pCh = fold(p(at), ignoreCase);
      switch (pCh) {
        case BACKSLASH:
          // Literally the next byte, and unfolded, as in git.
          at += 1;
          pCh = p(at);
          if (tCh !== pCh) {
            return NO_MATCH;
          }
          continue;
        case QUESTION:
          if (pathname && tCh === SLASH) {
            return NO_MATCH;
          }
          continue;
        case STAR: {
          let matchSlash: boolean;
          at += 1;
          if (p(at) === STAR) {
            const before = at - 2;
            while (p(++at) === STAR) {
              // A run of stars is one.
            }
            const next = p(at);
            if (
              (before < start || p(before) === SLASH) &&
              (next === NUL || next === SLASH || (next === BACKSLASH && p(at + 1) === SLASH))
            ) {
              // A whole `**` segment followed by a slash may stand for no
              // directory at all: `a/**/b` matches `a/b`.
              if (next === SLASH && dowild(at + 1, to) === MATCH) {
                return MATCH;
              }
              matchSlash = true;
            } else {
              matchSlash = false;
            }
          } else {
            matchSlash = !pathname;
          }
          if (p(at) === NUL) {
            // Trailing, `**` takes everything left and `*` everything up to a slash.
            return !matchSlash && text.indexOf('/', to) !== -1 ? NO_MATCH : MATCH;
          }
          if (!matchSlash && p(at) === SLASH) {
            // One `*` and then a slash: the rest of this directory's name.
            const slash = text.indexOf('/', to);
            if (slash === -1) {
              return NO_MATCH;
            }
            to = slash;
            break;
          }
          for (;;) {
            if (tCh === NUL) {
              break;
            }
            // A literal after the star: what comes before its next occurrence
            // can only belong to the star, so skip straight there.
            if (!GLOB_SPECIAL.test(pattern[at])) {
              const literal = fold(p(at), ignoreCase);
              while ((tCh = t(to)) !== NUL && (matchSlash || tCh !== SLASH)) {
                tCh = fold(tCh, ignoreCase);
                if (tCh === literal) {
                  break;
                }
                to += 1;
              }
              if (tCh !== literal) {
                return NO_MATCH;
              }
            }
            const matched = dowild(at, to);
            if (matched !== NO_MATCH) {
              if (!matchSlash || matched !== ABORT_TO_STARSTAR) {
                return matched;
              }
            } else if (!matchSlash && tCh === SLASH) {
              return ABORT_TO_STARSTAR;
            }
            to += 1;
            tCh = fold(t(to), ignoreCase);
          }
          return ABORT_ALL;
        }
        case OPEN: {
          at += 1;
          pCh = p(at);
          if (pCh === CARET) {
            pCh = BANG;
          }
          const negated = pCh === BANG;
          if (negated) {
            at += 1;
            pCh = p(at);
          }
          let previous = NUL;
          let matched = false;
          do {
            if (pCh === NUL) {
              return ABORT_ALL;
            }
            if (pCh === BACKSLASH) {
              at += 1;
              pCh = p(at);
              if (pCh === NUL) {
                return ABORT_ALL;
              }
              if (tCh === pCh) {
                matched = true;
              }
            } else if (pCh === DASH && previous !== NUL && p(at + 1) !== NUL && p(at + 1) !== CLOSE) {
              at += 1;
              pCh = p(at);
              if (pCh === BACKSLASH) {
                at += 1;
                pCh = p(at);
                if (pCh === NUL) {
                  return ABORT_ALL;
                }
              }
              if (tCh <= pCh && tCh >= previous) {
                matched = true;
              } else if (ignoreCase && isLower(tCh) && tCh - 0x20 <= pCh && tCh - 0x20 >= previous) {
                matched = true;
              }
              // A range is not the start of another.
              pCh = NUL;
            } else if (pCh === OPEN && p(at + 1) === COLON) {
              at += 2;
              const nameStart = at;
              while ((pCh = p(at)) !== NUL && pCh !== CLOSE) {
                at += 1;
              }
              if (pCh === NUL) {
                return ABORT_ALL;
              }
              if (at - nameStart - 1 < 0 || p(at - 1) !== COLON) {
                // No `:]`: the `[` was an ordinary member after all.
                at = nameStart - 2;
                pCh = OPEN;
                if (tCh === pCh) {
                  matched = true;
                }
                continue;
              }
              const name = pattern.slice(nameStart, at - 1);
              const test = Object.prototype.hasOwnProperty.call(CHARACTER_CLASSES, name)
                ? CHARACTER_CLASSES[name]
                : undefined;
              if (!test) {
                return ABORT_ALL;
              }
              if (test(tCh) || (name === 'upper' && ignoreCase && isLower(tCh))) {
                matched = true;
              }
              pCh = NUL;
            } else if (tCh === pCh) {
              matched = true;
            }
          } while (((previous = pCh), (at += 1), (pCh = p(at)) !== CLOSE));
          if (matched === negated || (pathname && tCh === SLASH)) {
            return NO_MATCH;
          }
          continue;
        }
        default:
          if (tCh !== pCh) {
            return NO_MATCH;
          }
          continue;
      }
    }
    return to < text.length ? NO_MATCH : MATCH;
  };

  try {
    return dowild(0, 0) === MATCH;
  } catch {
    // A pattern of tens of thousands of stars runs out of stack before it runs
    // out of text. Git would match it, slowly; here it matches nothing.
    return false;
  }
}
