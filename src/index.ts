#!/usr/bin/env node
/**
 * The entry point.
 *
 * This package is an MCP server first: the `cosense` CLI it wraps is already a
 * complete command line, and duplicating its commands here would be a second
 * place for them to drift. So there is no command set, only the server and
 * enough around it to see whether the server will work.
 */
import { READ_ONLY_COMMANDS, resolveCosenseBin, runCosense } from './cosense';

function cliVersion(): string {
  return require('../package.json').version as string;
}

const HELP = `cosensecli v${cliVersion()} - a read-only MCP server for Cosense

Usage:
  cosensecli --mcp-server    run the Model Context Protocol server over stdio
  cosensecli doctor          check that the cosense CLI underneath is usable
  cosensecli --version
  cosensecli --help

The tools are the read-only commands of the cosense CLI:
  ${READ_ONLY_COMMANDS.join(', ')}

Nothing here writes to Cosense. The editing commands of the cosense CLI
(previewEdit, submitEdit, previewDelete, replaceLinks, uploadFile, deleteFile)
are not reachable through this server; run them yourself with \`cosense\`.

Credentials are the cosense CLI's own: ~/.cosense/settings.json, or COSENSE_PAT.
A public project reads with no credentials at all.

Environment:
  COSENSECLI_COSENSE_BIN   the cosense executable to run, instead of the
                           bundled @helpfeel/cosense-cli
`;

/** Prints whether the underlying CLI is present and answering. */
function doctor(): number {
  const bin = resolveCosenseBin();
  process.stdout.write(`cosense binary: ${bin}\n`);
  try {
    const { stdout } = runCosense('whoami', ['https://scrapbox.io']);
    process.stdout.write(`authenticated:  yes\n${stdout}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 401|HTTP 403/.test(message)) {
      // Not a fault. Public projects read anonymously, which is the whole
      // reason this server does not require credentials to start.
      process.stdout.write(
        'authenticated:  no (public projects still readable; run `cosense login` for private ones)\n',
      );
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const [, , command] = process.argv;

const MCP_INVOCATIONS = new Set(['--mcp-server', '--mcp', 'mcp-server', 'mcp']);

if (command !== undefined && MCP_INVOCATIONS.has(command)) {
  // Required lazily: the MCP SDK is a large import that `doctor` and `--help`
  // would otherwise pay for at startup.
  const { runMcpServer } = require('./mcp') as typeof import('./mcp');
  runMcpServer().catch((error: any) => {
    console.error(`MCP server failed: ${error?.message || error}`);
    process.exit(1);
  });
} else if (command === '--version') {
  process.stdout.write(`cosensecli v${cliVersion()}\n`);
} else if (command === undefined || command === '--help' || command === '-h') {
  process.stdout.write(HELP);
} else if (command === 'doctor') {
  process.exit(doctor());
} else {
  process.stderr.write(`unknown command: ${command}\nSee \`cosensecli --help\`.\n`);
  process.exit(2);
}
