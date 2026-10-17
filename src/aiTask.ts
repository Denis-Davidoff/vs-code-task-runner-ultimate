/**
 * An AI task: a prompt handed to a coding agent's command line — Claude Code,
 * Codex or GitHub Copilot — run headless in the folder the task belongs
 * to, with what it is allowed to touch fixed by the task rather than by whatever
 * the agent's own configuration would ask about. Or handed to a command line of
 * the user's own choosing, or to a model behind an OpenAI-compatible API.
 *
 * It is a custom task whose value is an object instead of a command line, so it
 * shares their file, their names, their order and everything the tree files
 * against a row. This module is what that object is allowed to say; it touches
 * nothing, so the file reader and the tests can both use it as it is.
 */

/**
 * What runs a task's prompt. The first three are agents this extension knows:
 * it finds them, and holds each to the task's access with flags of its own.
 * `command` is any other command line, named in the task and given the prompt
 * on stdin — which nothing here can hold to anything, so it always runs with
 * full access. `api` is a model behind an OpenAI-compatible endpoint the user
 * has set up: it sees the prompt and nothing else, so it has no access to give.
 */
export type AiAgent = 'claude' | 'codex' | 'copilot' | 'command' | 'api';

/**
 * What the agent may do, from least to most. The order is the point: an
 * approval of one level covers every level below it. See `aiCovered`.
 */
export type AiAccess = 'read' | 'edit' | 'full';

/** Where the agent's final answer goes once it has finished. */
export type AiResult = 'report' | 'clipboard' | 'none';

/** What the notification says when it has: nothing, that it is done, or the answer itself. */
export type AiNotify = 'none' | 'done' | 'text';

export interface AiTask {
  agent: AiAgent;
  /** Passed to the agent as it is; absent leaves the agent's own default. */
  model?: string;
  /** For `api`: the name of a provider the user has set up on this machine — never its address or key. */
  provider?: string;
  /** For `command`: the command line the prompt is handed to. */
  command?: string;
  prompt: string;
  access: AiAccess;
  result: AiResult;
  notify: AiNotify;
}

export const AI_AGENTS: ReadonlyArray<AiAgent> = ['claude', 'codex', 'copilot', 'command', 'api'];

/** The agents this extension finds on the machine and runs with flags of its own. */
export type CliAgent = 'claude' | 'codex' | 'copilot';
export const CLI_AGENTS: ReadonlyArray<CliAgent> = ['claude', 'codex', 'copilot'];

export function isCliAgent(agent: AiAgent): agent is CliAgent {
  return (CLI_AGENTS as ReadonlyArray<string>).includes(agent);
}
export const AI_ACCESS: ReadonlyArray<AiAccess> = ['read', 'edit', 'full'];
export const AI_RESULTS: ReadonlyArray<AiResult> = ['report', 'clipboard', 'none'];
export const AI_NOTIFY: ReadonlyArray<AiNotify> = ['none', 'done', 'text'];

export const AGENT_LABEL: Record<AiAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  command: 'Command',
  api: 'API',
};

/**
 * The levels of access an agent can be held to. A command line of the user's
 * own takes whatever it takes — nothing here can narrow it — and a model behind
 * an API touches nothing at all, which the task records as read-only.
 */
export function agentAccess(agent: AiAgent): ReadonlyArray<AiAccess> {
  return agent === 'command' ? ['full'] : agent === 'api' ? ['read'] : AI_ACCESS;
}

export const ACCESS_LABEL: Record<AiAccess, string> = {
  read: 'Read-only',
  edit: 'Edit files',
  full: 'Full access',
};

/**
 * What each level means in words, for the picker that sets it and the dialog
 * that asks about it. Said as what the agent can do rather than as the flag it
 * becomes: the flags differ per agent, the consequences do not.
 */
export const ACCESS_DETAIL: Record<AiAccess, string> = {
  read: 'Reads the project. Cannot change files; runs only commands its agent counts as read-only.',
  edit: 'Reads and edits files in the project. Cannot run commands that change anything else.',
  full: 'Edits files and runs any command, without asking. Only for prompts you fully trust.',
};

export const RESULT_LABEL: Record<AiResult, string> = {
  report: 'Open a report',
  clipboard: 'Copy to clipboard',
  none: 'Nothing',
};

export const NOTIFY_LABEL: Record<AiNotify, string> = {
  none: 'No notification',
  done: 'Notify when done',
  text: 'Notify with the answer',
};

/**
 * A model name as an agent's `--model` takes it: `sonnet`, `gpt-5-codex`,
 * `claude-opus-5-5[1m]`. It goes to the agent as one argument and never through
 * a shell, but a value starting with `-` would still be read as a flag, and one
 * holding a space or a line break as something nobody can see in the picker.
 */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,99}$/;

export function validModel(model: string): boolean {
  return MODEL.test(model);
}

/** A provider's name, as the picker shows it and the task names it. */
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

export function validProvider(name: string): boolean {
  return PROVIDER.test(name);
}

/**
 * A command line for `command`: one line, short enough to read in a dialog.
 * What it may hold beyond that — hidden characters — is the approval's to
 * refuse, as for any custom task's command line.
 */
export function validCommand(command: string): boolean {
  return command.trim().length > 0 && command.length <= 500 && !/[\r\n]/.test(command);
}

/**
 * The task a custom tasks value describes, or `undefined` when it does not
 * describe one. `agent` and a non-empty `prompt` are required; the rest fall
 * back to the safest reading — read-only, a report, a notification when done.
 *
 * A value that is present and wrong is not a task at all rather than read as
 * one of the fallbacks. `"access": "ful"` taken as read-only would run a task
 * nobody wrote, and a row that does not appear is the one a reader looks for.
 */
export function parseAiTask(value: unknown): AiTask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const agent = raw.agent;
  if (typeof agent !== 'string' || !(AI_AGENTS as ReadonlyArray<string>).includes(agent)) {
    return undefined;
  }
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
    return undefined;
  }
  const pick = <T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T | undefined => {
    const found = raw[key];
    if (found === undefined) {
      return fallback;
    }
    return typeof found === 'string' && (allowed as ReadonlyArray<string>).includes(found) ? (found as T) : undefined;
  };
  const access = pick('access', AI_ACCESS, 'read');
  const result = pick('result', AI_RESULTS, 'report');
  const notify = pick('notify', AI_NOTIFY, 'done');
  if (!access || !result || !notify) {
    return undefined;
  }
  let model: string | undefined;
  if (raw.model !== undefined && raw.model !== '') {
    if (typeof raw.model !== 'string' || !validModel(raw.model)) {
      return undefined;
    }
    model = raw.model;
  }
  let provider: string | undefined;
  let command: string | undefined;
  if (agent === 'api') {
    // A provider has no default model to fall back on, so a task without one
    // is not a task: it could only fail when it ran.
    if (typeof raw.provider !== 'string' || !validProvider(raw.provider) || model === undefined) {
      return undefined;
    }
    provider = raw.provider;
  }
  if (agent === 'command') {
    if (typeof raw.command !== 'string' || !validCommand(raw.command)) {
      return undefined;
    }
    command = raw.command.trim();
  }
  return {
    agent: agent as AiAgent,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(command ? { command } : {}),
    // A file saved on Windows carries `\r\n`, which is the same prompt; the
    // approval compares text, and should not see a change in line endings.
    prompt: raw.prompt.replace(/\r\n/g, '\n'),
    // What the agent can be held to, whatever the file says: a command line
    // claiming to be read-only would be shown as read-only and run as anything.
    access: agentAccess(agent as AiAgent).includes(access) ? access : agentAccess(agent as AiAgent)[0],
    result,
    notify,
  };
}

/** The keys an AI task is made of; any other key on its object is somebody else's and is kept. */
export const AI_FIELDS: ReadonlyArray<string> = ['agent', 'model', 'provider', 'command', 'access', 'result', 'notify', 'prompt'];

/**
 * The object a task is written to the file as. Keys in the order a reader wants
 * them — who runs it and with what rights before the prompt, which can run to
 * pages — and the defaults written out, so the file says what will happen.
 */
export function aiTaskValue(task: AiTask): Record<string, string> {
  return {
    agent: task.agent,
    ...(task.provider ? { provider: task.provider } : {}),
    ...(task.command ? { command: task.command } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.agent === 'api' ? {} : { access: task.access }),
    result: task.result,
    notify: task.notify,
    prompt: task.prompt,
  };
}

/**
 * The dimmed text of an AI row: who runs it, with what rights, and the start of
 * the prompt — the start only, since a prompt can run to pages and this is drawn
 * on every repaint of the tree.
 */
export function aiDescription(task: AiTask): string {
  const prompt = task.prompt.slice(0, 400).replace(/\s+/g, ' ').trim();
  return `${agentText(task)} · ${accessText(task)} · ${prompt.length > 200 ? `${prompt.slice(0, 199)}…` : prompt}`;
}

/** Who runs a task, in a few words: the agent and its model, a provider and its model, or the command. */
export function agentText(task: AiTask): string {
  if (task.agent === 'api') {
    return task.model ? `${task.provider} (${task.model})` : `${task.provider}`;
  }
  if (task.agent === 'command') {
    const command = task.command ?? '';
    return `\`${command.length > 60 ? `${command.slice(0, 59)}…` : command}\``;
  }
  return task.model ? `${AGENT_LABEL[task.agent]} (${task.model})` : AGENT_LABEL[task.agent];
}

/** A task's access as the row says it — a model behind an API has none to speak of. */
export function accessText(task: AiTask): string {
  return task.agent === 'api' ? 'Text only' : ACCESS_LABEL[task.access];
}

/**
 * The part of a task an approval is of: the program, its rights, and what it is
 * told. The model is left out — swapping `sonnet` for `opus` changes how well a
 * prompt is carried out, not what the agent is allowed to do — and so are the
 * result and the notification, which happen in the editor, not to the project.
 */
interface AiApproved {
  agent: AiAgent;
  access: AiAccess;
  prompt: string;
  /**
   * The command line a `command` task hands the prompt to — the part a pull
   * would rewrite to run something else entirely. Absent for every other agent,
   * so their approvals read exactly as they did before it was added.
   */
  command?: string;
  /**
   * The provider an `api` task sends its prompt to — and the context in it, the
   * diff and the clipboard. A pull that moved a task from a local model to a
   * cloud one would send them off the machine, so that asks again too. The
   * model is left out, as an agent's is.
   */
  provider?: string;
}

/**
 * Marks an approval as an AI task's in the one map approvals share with the
 * command lines. A NUL is what no approved command line can hold — a line with
 * one is blocked before its approval is ever read — so whatever a pull rewrites
 * a task into, an AI approval is never mistaken for a command line's.
 */
const AI_APPROVAL = '\u0000ai:';

/** What is stored when a task is approved. */
export function aiApproval(task: AiTask): string {
  const approved: AiApproved = {
    agent: task.agent,
    access: task.access,
    prompt: task.prompt,
    ...(task.command !== undefined ? { command: task.command } : {}),
    ...(task.provider !== undefined ? { provider: task.provider } : {}),
  };
  return AI_APPROVAL + JSON.stringify(approved);
}

/** An AI approval read back, or `undefined` for a command line's or none. */
export function readAiApproval(stored: string | undefined): AiApproved | undefined {
  if (!stored?.startsWith(AI_APPROVAL)) {
    return undefined;
  }
  try {
    const data = JSON.parse(stored.slice(AI_APPROVAL.length)) as Partial<AiApproved>;
    return typeof data.prompt === 'string' &&
      AI_AGENTS.includes(data.agent as AiAgent) &&
      AI_ACCESS.includes(data.access as AiAccess) &&
      (data.command === undefined || typeof data.command === 'string') &&
      (data.provider === undefined || typeof data.provider === 'string')
      ? (data as AiApproved)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an approval covers a task as it is now: the same agent, the same
 * prompt, and rights no wider than the ones approved. Narrowing what a task may
 * do is never a reason to ask again; widening it always is.
 */
export function aiCovered(task: AiTask, stored: string | undefined): boolean {
  const approved = readAiApproval(stored);
  return (
    !!approved &&
    approved.agent === task.agent &&
    approved.prompt === task.prompt &&
    approved.command === task.command &&
    approved.provider === task.provider &&
    AI_ACCESS.indexOf(task.access) <= AI_ACCESS.indexOf(approved.access)
  );
}

/** What changed since the approval, in the words the dialog says it in. */
export function aiChanges(task: AiTask, stored: string | undefined): string[] {
  const approved = readAiApproval(stored);
  if (!approved) {
    return [];
  }
  const changes: string[] = [];
  if (approved.agent !== task.agent) {
    changes.push(`agent ${AGENT_LABEL[approved.agent]} → ${AGENT_LABEL[task.agent]}`);
  }
  if (AI_ACCESS.indexOf(task.access) > AI_ACCESS.indexOf(approved.access)) {
    changes.push(`access ${ACCESS_LABEL[approved.access]} → ${ACCESS_LABEL[task.access]}`);
  }
  if (approved.command !== task.command) {
    changes.push('command');
  }
  if (approved.provider !== task.provider) {
    changes.push(`provider ${approved.provider ?? 'none'} → ${task.provider ?? 'none'}`);
  }
  if (approved.prompt !== task.prompt) {
    changes.push('prompt');
  }
  return changes;
}

/** The prompt an approval was of, for the diff the dialog can open. */
export function approvedPrompt(stored: string | undefined): string | undefined {
  return readAiApproval(stored)?.prompt;
}
