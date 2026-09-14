import { execFile } from 'child_process';

/**
 * Asking Docker what is actually running.
 *
 * This is the one module that starts a process. Everything else here reads the
 * workspace through `vscode.workspace.fs` and never shells out — which is what
 * keeps the scan cheap and keeps it working over Remote SSH and in Dev
 * Containers, and is written down as an invariant in `sources.ts`. That
 * invariant is about the *scan*, and it still holds: nothing below runs while
 * manifests are being read. It runs when somebody asks.
 *
 * Kept apart from the rest so the boundary is a file and not a comment: an
 * import of `child_process` anywhere else is a mistake, and here it is the
 * point.
 */

/**
 * How long Docker is given to answer before the row is left saying nothing.
 *
 * A stopped daemon is the ordinary case this protects against — `docker compose
 * ps` against one can sit for a long time, and a person who asked a question
 * about their containers should not get a frozen menu for it. Silence is a
 * better answer than a wait: the rows fall back to "only what we started", which
 * is what they said before the question was asked.
 */
const PROBE_TIMEOUT_MS = 5000;
/** Ceiling on the output read, so a pathological `ps` cannot be a memory problem. */
const MAX_OUTPUT_BYTES = 2_000_000;

/** What Docker said about one compose file, or nothing when it could not be asked. */
export interface ComposeState {
  /** Names of the services with at least one container up. */
  running: Set<string>;
}

/**
 * The services compose reports as running for one file.
 *
 * `undefined` means the question could not be answered — Docker is not
 * installed, the daemon is down, the file was deleted, the call timed out. That
 * is deliberately not the same as an empty set, which means "asked, and nothing
 * is up": only the first should leave the previous answer alone rather than
 * replacing it with a false "everything is stopped".
 */
export async function composeState(argv: string[], cwd: string): Promise<ComposeState | undefined> {
  const [program, ...rest] = argv;
  if (!program) {
    return undefined;
  }

  const output = await run(program, [...rest, 'ps', '--format', 'json'], cwd);
  if (output === undefined) {
    return undefined;
  }

  const running = new Set<string>();
  for (const entry of parseRows(output)) {
    // `ps` without `--all` already lists only what is up, but the field is there
    // and honest, so a row that says otherwise is believed over the omission.
    const state = typeof entry.State === 'string' ? entry.State.toLowerCase() : 'running';
    const service = typeof entry.Service === 'string' ? entry.Service : undefined;
    if (service && (state === 'running' || state === 'restarting')) {
      running.add(service);
    }
  }
  return { running };
}

/**
 * The rows of a `--format json` answer, in both shapes compose has shipped: one
 * JSON object per line since v2.21, and a single JSON array before it. Neither
 * is announced anywhere, so both are simply tried.
 */
function parseRows(output: string): Array<Record<string, unknown>> {
  const asArray = tryParse(output);
  if (Array.isArray(asArray)) {
    return asArray.filter(isRow);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const row = tryParse(trimmed);
    if (isRow(row)) {
      rows.push(row);
    }
  }
  return rows;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The program's standard output, or nothing if it could not be run to a clean
 * finish. No argument is ever interpolated into a command line — `execFile`
 * hands the vector to the OS, so a path or a service name carrying a space or a
 * `$` is an argument and not code.
 */
function run(program: string, args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        program,
        args,
        { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    } catch {
      // `execFile` throws rather than calling back when the program name itself
      // is unusable, which a `dockerCompose` setting can make it.
      resolve(undefined);
    }
  });
}
