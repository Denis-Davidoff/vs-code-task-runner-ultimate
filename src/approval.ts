import * as crypto from 'crypto';

/**
 * Signed approvals. An approval of a custom task is the thing it approved — a
 * command line, or an AI task's agent, access and prompt — kept in workspace
 * storage, out of the project, so that nothing that can only write the
 * repository can approve anything.
 *
 * Workspace storage is a file all the same: a SQLite database in the user's
 * profile, which any program running as the user, or any other extension
 * reading it from disk, can write into. The signature is what keeps such a
 * write from passing as an approval. Each approval is stored with an HMAC of it
 * under a key kept in VS Code's secret storage — encrypted there, with the
 * encryption key held by the OS: the Keychain on macOS, DPAPI on Windows, the
 * keyring on Linux. A write to the database alone cannot sign anything, and an
 * approval whose HMAC does not match is no approval at all.
 *
 * How far that reaches is the OS's to say. On macOS another program needs the
 * user's leave to read the key; on Windows any program running as the user can
 * have DPAPI decrypt it, and on Linux without a keyring VS Code's own fallback is
 * weaker still. There it stops a stray write, not a program set on forging one.
 *
 * The approved text is kept beside its HMAC rather than replaced by it, so a
 * changed task can still show what it was. It is believed only once the HMAC
 * over it checks out. The task's name is not part of what is signed: an
 * approval says what may run, and a rename in the tree moves it to the new name
 * unchanged. Copying one to another task approves that task only if it would
 * run exactly the same thing.
 */

/** Marks a stored approval as signed. A NUL, like the AI marker, so no approvable command line starts with it. */
const SIGNED = '\u0000sig:';
const HMAC_LENGTH = 64;

function hmac(key: Uint8Array, text: string): string {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** A fresh key: 32 random bytes, as the text secret storage keeps. */
export function newApprovalKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

/** What is stored for an approval of `text`. */
export function signApproval(key: Uint8Array, text: string): string {
  return `${SIGNED}${hmac(key, text)}:${text}`;
}

/**
 * The approved text of a stored approval, or `undefined` when there is none to
 * believe: no key yet, a value that is not signed, or one whose signature does
 * not match what it says. Compared in constant time, which costs nothing and
 * leaves nothing to measure.
 */
export function verifyApproval(key: Uint8Array | undefined, stored: string | undefined): string | undefined {
  if (!key || !stored?.startsWith(SIGNED)) {
    return undefined;
  }
  const signature = stored.slice(SIGNED.length, SIGNED.length + HMAC_LENGTH);
  if (stored[SIGNED.length + HMAC_LENGTH] !== ':' || !/^[0-9a-f]{64}$/.test(signature)) {
    return undefined;
  }
  const text = stored.slice(SIGNED.length + HMAC_LENGTH + 1);
  const expected = Buffer.from(hmac(key, text), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? text : undefined;
}

/** Whether a stored value is signed at all, valid or not — what the one-time migration leaves alone. */
export function isSigned(stored: string): boolean {
  return stored.startsWith(SIGNED);
}

/**
 * Every unsigned approval signed as it stands. Run once per workspace, the first
 * time a key is there for it, so the approvals made before signing existed are
 * not all asked about again. Never run again after that: an unsigned value that
 * turns up later was not written by this extension, and signing it would be
 * approving whatever wrote it.
 */
export function signLegacyApprovals(key: Uint8Array, approvals: Record<string, string>): Record<string, string> {
  const signed: Record<string, string> = {};
  for (const [ref, value] of Object.entries(approvals)) {
    signed[ref] = isSigned(value) ? value : signApproval(key, value);
  }
  return signed;
}

/**
 * Every approval signed with `from` signed again with `to`, and anything else
 * left as it is — for when the key changes under a running window. The old
 * signature is the proof that the approval is this extension's own, so carrying
 * it over approves nothing that was not approved before.
 */
export function resignApprovals(
  from: Uint8Array,
  to: Uint8Array,
  approvals: Record<string, string>,
): Record<string, string> {
  const signed: Record<string, string> = {};
  for (const [ref, value] of Object.entries(approvals)) {
    const text = verifyApproval(from, value);
    signed[ref] = text === undefined ? value : signApproval(to, text);
  }
  return signed;
}
