import * as vscode from 'vscode';
import { parseJsonc } from './sources';

/**
 * The icons of whichever file icon theme the workbench is wearing, offered to
 * the picker beside the codicons.
 *
 * There is no API for this. A file icon theme is a JSON file an extension
 * contributes, and the workbench keeps what it made of it to itself — so the
 * catalogue below is read off disk, out of the extension folder of the theme
 * named by `workbench.iconTheme`.
 *
 * What is read is used for one thing only: the *preview* in the picker, which
 * needs an image to point at. Nothing in the tree ever draws one of these files.
 * A row that has been given a pack icon is drawn the way the manifest headings
 * already are — a `resourceUri` whose last segment is a name the theme knows,
 * and `ThemeIcon.File` — and the workbench resolves it itself. That is the whole
 * reason the catalogue stores a *specimen* name rather than the path of an
 * image:
 *
 * - it survives a change of icon pack. `_f_docker` means nothing to Material
 *   Icon Theme, but `Dockerfile` means the same thing to every pack there is.
 * - it survives a pack that has no images at all. Seti, the one that ships with
 *   VS Code, draws from a font, and a font glyph is not a file anything can be
 *   pointed at — but `ThemeIcon.File` reaches it exactly as it reaches an SVG.
 * - it follows the light and dark variants of a pack for free, which a path to
 *   one of the two files cannot.
 *
 * The cost is that the specimen has to be one the workbench resolves back to the
 * icon it was taken from, which is what `resolveFile` below is for.
 */

/** An icon of the active pack, as the picker offers it and the store keeps it. */
export interface PackIcon {
  /** The key the theme files this icon under — its identity within one pack. */
  readonly key: string;
  /** What the picker calls it, made out of that key. */
  readonly name: string;
  /** Whether the workbench has to be shown a file or a folder to draw it. */
  readonly kind: 'file' | 'folder';
  /** The name that makes the workbench draw it. See the note above. */
  readonly specimen: string;
  /** What the specimen is, said the way the picker shows it: `*.rs`, `src/`. */
  readonly hint: string;
  /** The image, relative to the theme file, for the preview in the picker. */
  readonly art?: string;
}

/**
 * Which set of associations a pack is read through. A theme file carries a base
 * set and optional `light`, `highContrast` and `highContrastLight` blocks that
 * override it, and the workbench picks between them by the *colour* theme — so
 * the same pack is a different catalogue in a light theme than in a dark one.
 */
type Variant = 'dark' | 'light' | 'hcDark' | 'hcLight';

export interface IconPack {
  /** The value of `workbench.iconTheme` this was read for. */
  readonly id: string;
  /** The colour-theme variant it was read through. */
  readonly variant: Variant;
  /** The pack's own name, for the separator the icons sit under. */
  readonly label: string;
  /** The folder the theme file sits in; `art` is relative to this. */
  readonly base: vscode.Uri;
  readonly icons: readonly PackIcon[];
  /** Specimen to image, for the one list that can only be handed a picture. */
  readonly art: ReadonlyMap<string, string>;
}

/**
 * A theme file is read once per pack and kept. It is a megabyte of JSON in the
 * larger packs, which is nothing to hold and too much to re-read every time the
 * picker opens — and it only ever changes when the pack does, which is what
 * `forgetIconPack` is called for.
 */
let cached: { id: string; variant: Variant; pack: IconPack | undefined } | undefined;

/**
 * Bumped by every invalidation, so a read that was already in flight when one
 * happened knows not to write its answer down. Without it an icon pack updated
 * mid-read puts the *previous* catalogue back into the cache after it was
 * dropped, and `packArt` then serves images from a folder that no longer exists.
 */
let generation = 0;

/** Drops the catalogue: the icon theme changed, the colour theme did, or the extension providing either. */
export function forgetIconPack(): void {
  cached = undefined;
  generation += 1;
}

/**
 * The active pack, or nothing when there is none to read: `workbench.iconTheme`
 * set to null is "no file icons at all", and a theme whose file cannot be read
 * or parsed is one the picker simply does not offer a section for.
 */
export async function iconPack(): Promise<IconPack | undefined> {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  if (!id) {
    return undefined;
  }
  const variant = activeVariant();
  if (cached?.id === id && cached.variant === variant) {
    return cached.pack;
  }
  const token = generation;
  const pack = await readPack(id, variant);
  // Written down only if nothing was invalidated while this was reading. The
  // answer still goes back to the caller that asked for it — it is the *cache*
  // that must not end up holding a pack somebody already said was gone.
  if (token === generation) {
    cached = { id, variant, pack };
  }
  return pack;
}

/**
 * The variant the workbench would resolve icons through right now. A missing
 * enum member on an older build compares false rather than throwing, which
 * leaves the base set — the same answer that build would give anyway.
 */
function activeVariant(): Variant {
  switch (vscode.window.activeColorTheme?.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'hcDark';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'hcLight';
    default:
      return 'dark';
  }
}

/**
 * The image behind a specimen, for a quick pick — which has no `resourceUri` to
 * resolve a `ThemeIcon.File` against on the versions this extension supports, and
 * so has to be handed the picture itself.
 *
 * Answers out of what has already been read and never goes to disk: it is called
 * while a list is being built, and a list that cannot be built without waiting is
 * one that opens empty. Nothing is lost by answering `undefined` — the caller
 * falls back to the glyph it would have used anyway — and the pack is read the
 * moment either list that needs it is opened.
 */
export function packArt(kind: 'file' | 'folder', specimen: string): vscode.Uri | undefined {
  const pack = cached?.pack;
  const art = pack?.art.get(`${kind}:${specimen}`);
  return art ? vscode.Uri.joinPath(pack!.base, art) : undefined;
}

/** A megabyte and a half is the largest pack on the marketplace; this is room over it. */
const MAX_THEME_BYTES = 8 * 1024 * 1024;

async function readPack(id: string, variant: Variant): Promise<IconPack | undefined> {
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON?.contributes?.iconThemes;
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const theme of themes) {
      if (theme?.id !== id || typeof theme?.path !== 'string') {
        continue;
      }
      const file = vscode.Uri.joinPath(extension.extensionUri, theme.path);
      const text = await readText(file);
      if (text === undefined) {
        return undefined;
      }
      let parsed: unknown;
      try {
        // Generated themes are plain JSON and hand-written ones are not; the
        // fast path costs a try and saves walking a megabyte a character at a
        // time in the case that is nearly all of them.
        parsed = JSON.parse(text);
      } catch {
        try {
          parsed = parseJsonc(text);
        } catch {
          return undefined;
        }
      }
      const icons = iconsFrom(parsed, languageSpecimens(), variant);
      if (icons.length === 0) {
        return undefined;
      }
      return {
        id,
        variant,
        label: nameOf(theme.label, extension.packageJSON?.displayName, id),
        // The paths inside a theme file are relative to the file, and reach out
        // of its folder often enough (`../../icons/x.svg`) that the join has to
        // be done against the folder rather than the extension root.
        base: vscode.Uri.joinPath(file, '..'),
        icons,
        art: new Map(
          icons
            .filter((icon) => icon.art)
            .map((icon) => [`${icon.kind}:${icon.specimen}`, icon.art as string]),
        ),
      };
    }
  }
  return undefined;
}

/**
 * What to call a pack in the picker. A manifest string can still be a `%key%`
 * placeholder if nothing translated it on the way in — which the workbench
 * normally does, and a built-in pack read before it did would otherwise be
 * offered under a separator saying `%themeLabel%`.
 */
function nameOf(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && !/^%.*%$/.test(candidate)) {
      return candidate;
    }
  }
  return 'File icons';
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    // Asked of the file system first, so a huge file is never pulled into the
    // extension host only to be thrown away — the same two-stage guard, and for
    // the same reason, as the manifest reader in `sources.ts`. The check after
    // the read stays: the file can grow between the two calls.
    const info = await vscode.workspace.fs.stat(uri);
    if (info.size > MAX_THEME_BYTES) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_THEME_BYTES) {
      return undefined;
    }
    const text = Buffer.from(bytes).toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

/**
 * A file name per language id, taken from the `contributes.languages` of every
 * extension installed.
 *
 * Some packs file a good part of their icons under language ids alone, and a
 * language id is not something a file name can be made up from — `julia` is a
 * `.jl` file only because some extension said so. So the map is built from the
 * same declarations the workbench itself resolves languages with.
 */
function languageSpecimens(): Map<string, string> {
  const names = new Map<string, string>();
  for (const extension of vscode.extensions.all) {
    const languages = extension.packageJSON?.contributes?.languages;
    if (!Array.isArray(languages)) {
      continue;
    }
    for (const language of languages) {
      const id = language?.id;
      if (typeof id !== 'string' || names.has(id)) {
        continue;
      }
      const named = pickString(language.filenames);
      const extended = pickString(language.extensions);
      // The extension is preferred: a `filenames` entry is often a one-off
      // (`.bashrc` for shell) where the extension is the ordinary case.
      const specimen = extended?.startsWith('.') ? `icon${extended}` : named;
      if (specimen) {
        names.set(id, specimen);
      }
    }
  }
  return names;
}

function pickString(values: unknown): string | undefined {
  return Array.isArray(values)
    ? values.find((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined;
}

/** The association maps of a theme file — the base set, and each override block. */
interface Associations {
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  languageIds?: Record<string, string>;
  folderNames?: Record<string, string>;
}

/** The shape of a theme file, as much of it as the catalogue reads. */
interface ThemeFile extends Associations {
  iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string } | undefined>;
  light?: Associations;
  highContrast?: Associations;
  highContrastLight?: Associations;
}

/**
 * The catalogue, out of a parsed theme file. Exported plain and without a `vscode`
 * of its own so it can be tested against a theme file and nothing else.
 *
 * One entry per icon definition, and the definition is only listed once a
 * specimen has been found that the workbench resolves *back* to it — see
 * `resolveFile`. An icon nothing can be named to reach is an icon the picker
 * would offer and the tree would then draw as something else.
 *
 * The expanded-folder and light-variant maps are deliberately not read: they are
 * the same icons in another state, and a picker with `Src` and `Src Open` in it
 * is a longer list saying the same thing twice. The workbench picks the variant
 * itself, from the state of the row it is drawing.
 */
export function iconsFrom(
  theme: unknown,
  languages: ReadonlyMap<string, string> = new Map(),
  variant: Variant = 'dark',
): PackIcon[] {
  const spec = (theme ?? {}) as ThemeFile;
  const defs = spec.iconDefinitions;
  if (!defs || typeof defs !== 'object') {
    return [];
  }
  // The override block for this colour theme, laid over the base set the way the
  // workbench lays it over: an association the block does not mention keeps the
  // base icon, and one it does mention replaces it. Reading the base set alone
  // would offer icons a light theme never draws, and preview each overridden one
  // as the dark artwork of an icon the row will not wear.
  const over = overrides(spec, variant);
  const fileNames = lowered(spec.fileNames, over?.fileNames);
  const fileExtensions = lowered(spec.fileExtensions, over?.fileExtensions);
  const folderNames = lowered(spec.folderNames, over?.folderNames);
  const languageIds = entries({ ...spec.languageIds, ...over?.languageIds });

  /**
   * Every name that reaches a definition, before any of them is chosen. The
   * choice is made per definition rather than per pass, because the best name
   * for an icon is the one that reads like the icon — see `bestOf`.
   */
  const candidates = new Map<string, Candidate[]>();
  const offer = (key: string, candidate: Candidate): void => {
    // `hasOwn`, not a truthiness test: `constructor` and `toString` are on every
    // object, and a theme naming one of them would otherwise put a definition in
    // the catalogue that has no icon behind it at all.
    if (!Object.prototype.hasOwnProperty.call(defs, key) || !defs[key]) {
      return;
    }
    const list = candidates.get(key);
    if (list) {
      list.push(candidate);
    } else {
      candidates.set(key, [candidate]);
    }
  };

  for (const [name, key] of folderNames) {
    offer(key, { kind: 'folder', specimen: name, hint: `${name}/`, rank: 0 });
  }
  for (const [extension, key] of fileExtensions) {
    // An association qualified by a parent folder cannot be reached by a bare
    // file name, and `icon.src/js` names a file called `js` inside a folder
    // called `icon.src` — which our own resolver would accept and the workbench
    // would not. Such keys are left to the passes that can spell them.
    if (extension.includes('/')) {
      continue;
    }
    const specimen = `icon.${extension}`;
    // `icon.ts` would be the wrong specimen for the `ts` icon if the pack also
    // had a rule for a file *called* `icon.ts`. Vanishingly unlikely, and the
    // check is a map lookup.
    if (resolveFile(specimen, fileNames, fileExtensions) === key) {
      offer(key, { kind: 'file', specimen, hint: `*.${extension}`, rank: 1 });
    }
  }
  for (const [name, key] of fileNames) {
    if (resolveFile(name, fileNames, fileExtensions) === key) {
      offer(key, { kind: 'file', specimen: name, hint: name, rank: 2 });
    }
  }
  for (const [id, key] of languageIds) {
    const specimen = languages.get(id);
    // A language specimen is the one kind that cannot be checked: whether the
    // workbench reads `icon.jl` as Julia is a question about the installed
    // language extensions, not about the theme. So it is only taken when the
    // name reaches no file rule at all — where the answer is either this icon or
    // the pack's default, and never somebody else's icon.
    if (specimen && resolveFile(specimen, fileNames, fileExtensions) === undefined) {
      offer(key, { kind: 'file', specimen, hint: id, rank: 3 });
    }
  }

  const found = new Map<string, PackIcon>();
  for (const [key, list] of candidates) {
    const definition = defs[key];
    // The name is read twice: once to choose between the candidates, and once
    // for the entry itself — because which prefix is dropped from a key depends
    // on what kind of thing the chosen candidate turned out to be.
    const pick = bestOf(list, prettyName(key, list[0].kind));
    found.set(key, {
      key,
      name: prettyName(key, pick.kind),
      kind: pick.kind,
      specimen: pick.specimen,
      hint: pick.hint,
      art: typeof definition?.iconPath === 'string' ? definition.iconPath : undefined,
    });
  }

  return [...found.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.hint.localeCompare(right.hint),
  );
}

/** One name that reaches a definition, with the pass it came from. */
interface Candidate {
  readonly kind: 'file' | 'folder';
  readonly specimen: string;
  readonly hint: string;
  /** Which pass offered it: folder, extension, file name, language, in that order. */
  readonly rank: number;
}

/**
 * The name an icon is best shown under. A definition is reached by a dozen names
 * in the larger packs — the Docker icon by `compose.yml`, `.dockerignore` and
 * `dockerfile` alike — and which one the picker prints decides whether the row
 * reads as the thing it is.
 *
 * A name that has the icon's own name inside it wins, which is what makes the
 * Docker icon say `dockerfile` rather than whichever of its dozen names happens
 * to be shortest. Failing that the earlier pass wins, an extension being the
 * more general statement of the two, and the shorter name after that.
 */
function bestOf(candidates: readonly Candidate[], name: string): Candidate {
  const word = simplify(name);
  const score = (candidate: Candidate): number => {
    const hint = simplify(candidate.hint);
    return word.length > 1 && (hint.includes(word) || word.includes(hint)) ? 0 : 1;
  };
  return [...candidates].sort(
    (left, right) =>
      score(left) - score(right) ||
      left.rank - right.rank ||
      left.hint.length - right.hint.length ||
      left.hint.localeCompare(right.hint),
  )[0];
}

/** Down to letters and digits, so `docker-compose.yml` and `Docker` can be compared. */
function simplify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Which icon the workbench would draw for a file of this name, by the rules a
 * theme is matched with: the whole name first, then the longest extension that
 * matches, and languages after both — which this stops short of, for the reason
 * given where it is called.
 */
function resolveFile(
  name: string,
  fileNames: ReadonlyMap<string, string>,
  fileExtensions: ReadonlyMap<string, string>,
): string | undefined {
  const lower = name.toLowerCase();
  const exact = fileNames.get(lower);
  if (exact) {
    return exact;
  }
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const match = fileExtensions.get(parts.slice(i).join('.'));
    if (match) {
      return match;
    }
  }
  return undefined;
}

function entries(map: Record<string, string> | undefined): Array<[string, string]> {
  return map && typeof map === 'object'
    ? Object.entries(map).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].length > 0,
      )
    : [];
}

/**
 * The name maps of a theme are matched case-insensitively, so they are held that
 * way — the override block last, since what it names is what the workbench draws.
 */
function lowered(
  base: Record<string, string> | undefined,
  over?: Record<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, key] of entries(base)) {
    const lower = name.toLowerCase();
    if (!out.has(lower)) {
      out.set(lower, key);
    }
  }
  for (const [name, key] of entries(over)) {
    out.set(name.toLowerCase(), key);
  }
  return out;
}

/**
 * The block that stands in front of the base set for this colour theme. A high
 * contrast theme falls back to the ordinary light or dark block when the pack
 * carries no block of its own — which is what the workbench does with it, and
 * what nearly every pack expects, since almost none ship one.
 */
function overrides(spec: ThemeFile, variant: Variant): Associations | undefined {
  switch (variant) {
    case 'light':
      return spec.light;
    case 'hcDark':
      return spec.highContrast;
    case 'hcLight':
      return spec.highContrastLight ?? spec.light;
    default:
      return undefined;
  }
}

/**
 * A definition key made readable. The keys are how a pack talks to itself —
 * `_f_docker`, `_fd_android`, `file_type_rust`, `folder-src` — so the prefix that
 * says which of its own maps an icon belongs in is dropped, and what is left is
 * the name of the thing.
 */
function prettyName(key: string, kind: 'file' | 'folder'): string {
  let name = key.replace(/^_+/, '');
  name = name.replace(/^(?:file_type|folder_type|folder|file|fd|f)[-_]/, '');
  if (kind === 'folder') {
    name = name.replace(/^folder[-_]/, '');
  }
  // The variant marker a pack puts in the key of its light artwork is not part
  // of the name of the thing: in a light theme every second entry would open
  // with the word `Light`, which sorts them all under one letter and says only
  // what the whole list already is. Matched as a whole word, so `lighthouse`
  // and `highlight` keep theirs.
  name = name.replace(/^light[-_]/, '').replace(/[-_]light$/, '');
  name = name.replace(/[-_]+/g, ' ').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : key;
}
