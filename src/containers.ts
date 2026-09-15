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

  const json = await run(program, [...rest, ...V2_PROBE], cwd);
  if (json.output !== undefined) {
    const running = new Set<string>();
    for (const entry of parseRows(json.output)) {
      // `ps` without `--all` already lists only what is up, but the field is
      // there and honest, so a row that says otherwise is believed over the
      // omission.
      const state = typeof entry.State === 'string' ? entry.State.toLowerCase() : 'running';
      const service = typeof entry.Service === 'string' ? entry.Service : undefined;
      if (service && (state === 'running' || state === 'restarting')) {
        running.add(service);
      }
    }
    return { running };
  }
  // A timeout is the daemon, not the flags, and asking the same question twice
  // of something that is not answering only doubles the wait.
  if (json.timedOut) {
    return undefined;
  }

  const plain = await run(program, [...rest, ...V1_PROBE], cwd);
  if (plain.output === undefined) {
    return undefined;
  }
  return { running: new Set(serviceNames(plain.output)) };
}

/**
 * The question, in the two spellings compose has had.
 *
 * `--format json` is a v2 flag. The standalone v1 binary — which
 * `taskRunnerUltimate.dockerCompose` still offers, and which is still what
 * `docker-compose` is on plenty of machines — rejects it outright, and every
 * probe then failed the way a stopped daemon does: silently, with the rows never
 * marked up and the ■ that stops somebody else's stack never appearing. So the
 * v1 form is asked next, and it is the *filtered* one: `--services` alone lists
 * every service the file declares, running or not, which would claim a stopped
 * stack is up.
 *
 * The retry costs a second process for a file that could not be answered for at
 * all — a daemon that is down now fails twice instead of once. That is paid in
 * the path that was already the slow one, and only outside the timeout above.
 */
const V2_PROBE = ['ps', '--format', 'json'];
const V1_PROBE = ['ps', '--services', '--filter', 'status=running'];

/**
 * The service names in a v1 answer: one per line, and nothing else is one.
 *
 * Compose writes its warnings to stderr, so a line here is a name — but the
 * shape is checked all the same, since what this decides is whether a row claims
 * to be up, and an unexpected sentence must not become a service.
 */
function serviceNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line));
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
 *
 * Whether the answer ran out of time is reported beside it: a flag the program
 * does not know is worth asking again in another spelling, and a daemon that
 * never answers is not.
 */
function run(program: string, args: string[], cwd: string): Promise<{ output?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    try {
      execFile(
        program,
        args,
        { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout) =>
          resolve(
            error
              ? // `killed` is how `execFile` reports the timeout it enforces
                // itself; a program that exited on its own carries an exit code.
                { timedOut: (error as { killed?: boolean }).killed === true }
              : { output: stdout, timedOut: false },
          ),
      );
    } catch {
      // `execFile` throws rather than calling back when the program name itself
      // is unusable, which a `dockerCompose` setting can make it. Nothing was
      // started, so there is nothing a second spelling would reach either.
      resolve({ timedOut: true });
    }
  });
}
