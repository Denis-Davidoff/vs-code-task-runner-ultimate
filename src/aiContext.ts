import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Context put into a prompt as it runs: `${gitDiff}` becomes the uncommitted
 * changes, `${selection}` the text selected in the editor, and so on. An agent
 * that reads the project could go and look for these itself; a model behind an
 * API sees nothing but the prompt, and for it this is the whole of what it
 * knows about the project.
 *
 * What is approved is the prompt as written, with the variables in it. What
 * they hold is the user's own work at the moment they run it, as much as what
 * an agent reads while it works is — and is read, like that, as data.
 */
export const CONTEXT_VARIABLES = {
  selection: 'the text selected in the active editor',
  file: 'the whole of the file in the active editor',
  filePath: 'the path of that file, inside its workspace folder',
  gitDiff: 'every uncommitted change to tracked files — `git diff HEAD`',
  gitDiffStaged: 'the changes staged for commit — `git diff --cached`',
  gitLog: 'the last 30 commits, one line each',
  clipboard: 'what is on the clipboard',
} as const;

export type ContextVariable = keyof typeof CONTEXT_VARIABLES;

const PATTERN = new RegExp(`\\$\\{(${Object.keys(CONTEXT_VARIABLES).join('|')})\\}`, 'g');

/** How much of a value goes into a prompt: all of it, or `VALUE_LIMIT` of it. */
export function sentLength(value: string | undefined): number {
  return Math.min(value?.length ?? 0, VALUE_LIMIT);
}

/**
 * Most a single value may add to a prompt. A diff of a vendored folder can run
 * to megabytes, and a prompt that size is refused by every model or costs a
 * fortune; past this, the value is cut and says so.
 */
const VALUE_LIMIT = 200_000;

/** The variables a prompt uses, each once, in the order it first uses them. */
export function usedVariables(prompt: string): ContextVariable[] {
  return [...new Set([...prompt.matchAll(PATTERN)].map((match) => match[1] as ContextVariable))];
}

/**
 * The prompt with each variable replaced by its value — in one pass, so a value
 * that happens to hold `${gitDiff}` is text, not a second substitution. A name
 * this does not know is left as it is.
 */
export function substitute(prompt: string, values: Partial<Record<ContextVariable, string>>): string {
  return prompt.replace(PATTERN, (whole, name: ContextVariable) => {
    const value = values[name];
    if (value === undefined) {
      return whole;
    }
    return value.length > VALUE_LIMIT
      ? `${value.slice(0, VALUE_LIMIT)}\n[… ${value.length - VALUE_LIMIT} more characters cut]`
      : value;
  });
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(
      'git',
      // Plain output whatever the user's config says: no pager, no colour codes
      // a model would read as part of the diff.
      ['--no-pager', '-c', 'color.ui=never', ...args],
      {
        cwd,
        timeout: 15_000,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        // Windows looks for a program in the current directory before PATH,
        // and the current directory is the project: a `git.exe` a pull put
        // there would run in place of git. This turns that lookup off.
        env: process.platform === 'win32' ? { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } : process.env,
      },
      (error, stdout, stderr) => {
        // More than the buffer holds is a diff to cut, not a failure: what was
        // read is kept, and `substitute` cuts it to size and says so.
        if ((error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve(`${stdout}\n[… cut: git printed more than 20 MB]`);
          return;
        }
        resolve(error ? `(git ${args[0]} failed: ${String(stderr || error.message).trim().split('\n')[0]})` : stdout);
      },
    );
  });
}

/** The value of each variable a prompt uses, read now. */
export async function contextValues(
  names: ReadonlyArray<ContextVariable>,
  cwd: string,
): Promise<Partial<Record<ContextVariable, string>>> {
  const editor = vscode.window.activeTextEditor;
  const values: Partial<Record<ContextVariable, string>> = {};
  for (const name of names) {
    switch (name) {
      case 'selection':
        values.selection = editor ? editor.document.getText(editor.selection) : '';
        break;
      case 'file':
        values.file = editor ? editor.document.getText() : '';
        break;
      case 'filePath': {
        const uri = editor?.document.uri;
        const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
        values.filePath =
          uri && folder ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') : (uri?.fsPath ?? '');
        break;
      }
      case 'gitDiff':
        values.gitDiff = await git(cwd, ['diff', 'HEAD']);
        break;
      case 'gitDiffStaged':
        values.gitDiffStaged = await git(cwd, ['diff', '--cached']);
        break;
      case 'gitLog':
        values.gitLog = await git(cwd, ['log', '-n', '30', '--pretty=format:%h %ad %an: %s', '--date=short']);
        break;
      case 'clipboard':
        values.clipboard = await vscode.env.clipboard.readText();
        break;
    }
  }
  return values;
}
