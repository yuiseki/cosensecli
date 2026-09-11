/**
 * Running the `cosense` CLI as a child process.
 *
 * This package owns no knowledge of the Cosense API. `@helpfeel/cosense-cli`
 * holds all of it, and keeps holding it as Cosense changes, so the job here is
 * to start it, hand it arguments, and pass its output back. The CLI already
 * formats for a reader rather than a parser, which is what an MCP tool wants.
 *
 * Read-only is enforced here rather than promised in a README. Nothing in this
 * file can name a command that writes, because a command that is not in the
 * allowlist never reaches the child.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The commands this package is willing to run. Every one of them only reads.
 *
 * The write side of the CLI (previewEdit, previewDelete, submitEdit,
 * replaceLinks, uploadFile, deleteFile, downloadFile) is deliberately absent,
 * and so is `login`, which writes credentials to disk. An MCP client asking
 * for one gets the same answer as one asking for a command that does not
 * exist.
 */
export const READ_ONLY_COMMANDS = [
  'browsePage',
  'browsePageChanges',
  'browseRelatedPages',
  'list1hopLinks',
  'list2hopLinks',
  'listPageSnapshots',
  'listPages',
  'listProjects',
  'readFileInfo',
  'readPage',
  'readPageSnapshot',
  'readProjectMembers',
  'search1hopLinks',
  'search2hopLinks',
  'searchFullText',
  'searchVector',
  'whoami',
] as const;

export type ReadOnlyCommand = (typeof READ_ONLY_COMMANDS)[number];

const READ_ONLY_SET: ReadonlySet<string> = new Set(READ_ONLY_COMMANDS);

export function isReadOnlyCommand(command: string): command is ReadOnlyCommand {
  return READ_ONLY_SET.has(command);
}

/**
 * Where the `cosense` executable is.
 *
 * Normally it is the dependency's own bin, resolved through its package.json
 * so that the lookup does not depend on how npm laid out node_modules. The
 * environment variable is how the tests point at a stub, and how an operator
 * can pin a checkout without reinstalling.
 */
export function resolveCosenseBin(): string {
  const override = process.env.COSENSECLI_COSENSE_BIN;
  if (override && override.trim() !== '') {
    return override.trim();
  }
  const manifest = require.resolve('@helpfeel/cosense-cli/package.json');
  return path.join(path.dirname(manifest), 'bin', 'cosense');
}

export class CosenseCommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(params: { command: string; exitCode: number | null; stderr: string }) {
    const detail = params.stderr.trim() || `exited with code ${params.exitCode}`;
    super(`cosense ${params.command}: ${detail}`);
    this.name = 'CosenseCommandError';
    this.command = params.command;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
  }
}

/** How long a single call may take before it is killed, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

export type CosenseResult = {
  stdout: string;
  stderr: string;
};

/**
 * Runs one read-only cosense command and returns what it printed.
 *
 * The child is started with this process's own interpreter rather than through
 * a shell, so an argument holding a space, a quote or a semicolon is one
 * argument and never a second command. Cosense page titles are long Japanese
 * sentences that routinely contain all three.
 */
export function runCosense(
  command: string,
  args: string[] = [],
  options: { timeoutMs?: number } = {},
): CosenseResult {
  if (!isReadOnlyCommand(command)) {
    throw new Error(
      `${command} is not a read-only cosense command. This server runs only: ` +
        `${READ_ONLY_COMMANDS.join(', ')}.`,
    );
  }

  const bin = resolveCosenseBin();
  const result = spawnSync(process.execPath, [bin, command, ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    // The child reads stdin only for the editing commands, which this package
    // will not run. Closing it keeps a child from waiting on a pipe nobody
    // writes to.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    const reason = (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `the cosense CLI was not found at ${bin}`
      : result.error.message;
    throw new Error(`Could not run cosense ${command}: ${reason}`);
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.status !== 0) {
    throw new CosenseCommandError({ command, exitCode: result.status, stderr });
  }

  return { stdout, stderr };
}
