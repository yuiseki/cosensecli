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
import { DEFAULT_PROJECT_ENV, defaultProjectUrl, resolveProjectUrl } from './defaults';
import { crawlLinks, getIndex } from './pages';

function cliVersion(): string {
  return require('../package.json').version as string;
}

const HELP = `cosensecli v${cliVersion()} - a read-only MCP server for Cosense

Usage:
  cosensecli --mcp-server    run the Model Context Protocol server over stdio
  cosensecli doctor          check that the cosense CLI underneath is usable
  cosensecli crawl [<projectUrl>] [--budget <n>]
                             read page bodies into the cache, for ranking by
                             outgoing links
  cosensecli --version
  cosensecli --help

The tools are the read-only commands of the cosense CLI:
  ${READ_ONLY_COMMANDS.join(', ')}

Nothing here writes to Cosense. The editing commands of the cosense CLI
(previewEdit, submitEdit, previewDelete, replaceLinks, uploadFile, deleteFile)
are not reachable through this server; run them yourself with \`cosense\`.

Credentials are the cosense CLI's own: ~/.cosense/settings.json, or COSENSE_PAT.
A public project reads with no credentials at all.

Set a default project and a question no longer has to name one, which is the
point over MCP: "what did I write about X" rather than "in project Y, what did
I write about X". Every tool still takes a project URL, and a given one wins.

\`crawl\` is the bulk form of what the ranking tool does a bite at a time. A page
body is one request and one process, about 0.84s, so a few thousand pages is
the better part of an hour: worth a cron entry, not a tool call. Nothing
already current is read again, so running it twice costs almost nothing.

Environment:
  COSENSECLI_DEFAULT_PROJECT  the project a call is about when it names none,
                              e.g. https://scrapbox.io/yuiseki
  COSENSECLI_CACHE_DIR        where the index and page links are kept
                              (default: ~/.cache/cosensecli)
  COSENSECLI_COSENSE_BIN      the cosense executable to run, instead of the
                              bundled @helpfeel/cosense-cli
`;

/** Prints whether the underlying CLI is present and answering. */
function doctor(): number {
  const bin = resolveCosenseBin();
  process.stdout.write(`cosense binary: ${bin}\n`);
  try {
    const project = defaultProjectUrl();
    process.stdout.write(
      `default project: ${project ?? `none (set ${DEFAULT_PROJECT_ENV})`}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    const { stdout } = runCosense('whoami', ['https://scrapbox.io']);
    process.stdout.write(`authenticated:  yes\n${stdout}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Not a fault. Public projects read anonymously, which is the whole reason
    // this server does not require credentials to start. The CLI says this two
    // ways: it refuses locally when no token is stored, and it relays the
    // server's 401 or 403 when a token is there but not accepted. Matching only
    // the HTTP form reported the ordinary case as a broken installation.
    if (/HTTP 401|HTTP 403|No Personal Access Token/i.test(message)) {
      process.stdout.write(
        'authenticated:  no (public projects still readable; run `cosense login` for private ones)\n',
      );
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

/** Reads page bodies into the cache, reporting as it goes. */
function crawl(args: string[]): number {
  let budget = Number.POSITIVE_INFINITY;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--budget') {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        process.stderr.write('--budget needs a positive number.\n');
        return 2;
      }
      budget = value;
      i += 1;
    } else if (args[i].startsWith('--')) {
      process.stderr.write(`unknown option: ${args[i]}\n`);
      return 2;
    } else {
      positional.push(args[i] as string);
    }
  }

  let project: string;
  try {
    project = resolveProjectUrl(positional[0]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(`project: ${project}\n`);
  const { index, refreshed } = getIndex(project, { refresh: true });
  process.stdout.write(
    `index: ${index.pages.length} pages${refreshed ? ' (just walked)' : ''}\n`,
  );

  const started = Date.now();
  const report = crawlLinks(project, index, {
    budget: Number.isFinite(budget) ? budget : index.pages.length,
    onProgress: (done, total) => {
      // Carriage return rather than a line each, so a crawl of thousands does
      // not bury whatever the operator ran it from.
      process.stdout.write(`\r  read ${done}/${total}`);
    },
  });
  if (report.fetched > 0) process.stdout.write('\n');

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `read ${report.fetched} in ${seconds}s, ${report.current} already current, ` +
      `${report.remaining} to go${report.failed > 0 ? `, ${report.failed} failed` : ''}\n`,
  );
  return 0;
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
} else if (command === 'crawl') {
  process.exit(crawl(process.argv.slice(3)));
} else {
  process.stderr.write(`unknown command: ${command}\nSee \`cosensecli --help\`.\n`);
  process.exit(2);
}
