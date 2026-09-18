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
import {
  DEFAULT_PROJECT_ENV,
  defaultProjectSource,
  defaultProjectUrl,
  normalizeProjectUrl,
  resolveProjectUrl,
} from './defaults';
import { configPath, loadConfig, saveConfig } from './config';
import { bodyCoverage, collectUrls, crawlLinks, getIndex } from './pages';

function cliVersion(): string {
  return require('../package.json').version as string;
}

const HELP = `cosensecli v${cliVersion()} - a read-only MCP server for Cosense

Usage:
  cosensecli --mcp-server    run the Model Context Protocol server over stdio
  cosensecli config set default-project <name|url>
  cosensecli config get default-project
                             the project a command or tool is about when it
                             names none
  cosensecli doctor          check that the cosense CLI underneath is usable
  cosensecli crawl [<projectUrl>] [--budget <n>]
                             read page bodies into the cache, for ranking by
                             outgoing links and for listing URLs
  cosensecli list-urls [<projectUrl>] [--host <suffix>] [--with-page] [--json]
                             every URL found in the page bodies read so far
  cosensecli list-gyazo [<projectUrl>] [--with-page] [--json]
                             the same, narrowed to Gyazo
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

  cosensecli config set default-project yuiseki

A bare name means scrapbox.io; a URL is taken as given, so another host works
too. The value is stored in ~/.config/cosensecli/projects.json.
COSENSECLI_DEFAULT_PROJECT overrides it, which is how a service unit points at
one project without changing what the same user gets at a terminal.

\`crawl\` is the bulk form of what the ranking tool does a bite at a time. A page
body is one request and one process, about 0.84s, so a few thousand pages is
the better part of an hour: worth a cron entry, not a tool call. Nothing
already current is read again, so running it twice costs almost nothing.

\`list-urls\` and \`list-gyazo\` read the cache and never fetch. They cover the
pages crawled so far and say on stderr how many that is, so a partial answer is
not mistaken for the whole project. Run \`crawl\` first for all of it.

Environment:
  COSENSECLI_DEFAULT_PROJECT  the project a call is about when it names none,
                              e.g. https://scrapbox.io/yuiseki
  COSENSECLI_CACHE_DIR        where the index and page links are kept
                              (default: ~/.cache/cosensecli)
  COSENSECLI_COSENSE_BIN      the cosense executable to run, instead of the
                              bundled @helpfeel/cosense-cli
`;

/** Reads and writes the stored settings. */
function config(args: string[]): number {
  const [action, key, ...rest] = args;

  if (action !== 'set' && action !== 'get') {
    process.stderr.write(
      'Usage: cosensecli config set default-project <name|url>\n' +
        '       cosensecli config get default-project\n',
    );
    return 2;
  }
  if (key !== 'default-project') {
    process.stderr.write(
      `unknown setting: ${key ?? '(none)'}. The only one is default-project.\n`,
    );
    return 2;
  }

  if (action === 'get') {
    let value: string | undefined;
    try {
      value = defaultProjectUrl();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (value === undefined) {
      process.stderr.write(
        'No default project. Set one with `cosensecli config set ' +
          'default-project <name>`.\n',
      );
      return 1;
    }
    process.stdout.write(`${value}\n`);
    // Where it came from goes to stderr, so `$(cosensecli config get ...)`
    // captures the value alone.
    const source = defaultProjectSource();
    if (source === 'environment') {
      process.stderr.write(
        `from ${DEFAULT_PROJECT_ENV}, which overrides ${configPath()}\n`,
      );
    } else {
      process.stderr.write(`from ${configPath()}\n`);
    }
    return 0;
  }

  const given = rest[0];
  if (given === undefined) {
    process.stderr.write('Usage: cosensecli config set default-project <name|url>\n');
    return 2;
  }

  let normalized: string;
  try {
    // Normalised before it is written, so a mistake is an error here rather
    // than on every later call that reads the file.
    normalized = normalizeProjectUrl(given, 'default-project');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let stored;
  try {
    stored = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const file = saveConfig({ ...stored, default: normalized });
  process.stdout.write(`default-project: ${normalized}\n`);
  process.stderr.write(`written to ${file}\n`);

  if (defaultProjectSource() === 'environment') {
    // Saying nothing here would leave someone wondering why the thing they
    // just set is not the thing being used.
    process.stderr.write(
      `note: ${DEFAULT_PROJECT_ENV} is set and overrides this file, so ` +
        `commands in this environment still use ${defaultProjectUrl()}.\n`,
    );
  }
  return 0;
}

/** Prints whether the underlying CLI is present and answering. */
function doctor(): number {
  const bin = resolveCosenseBin();
  process.stdout.write(`cosense binary: ${bin}\n`);
  try {
    const project = defaultProjectUrl();
    const source = defaultProjectSource();
    process.stdout.write(
      `default project: ${project ?? 'none (run `cosensecli config set default-project <name>`)'}` +
        `${project ? ` (from the ${source === 'environment' ? 'environment' : 'config file'})` : ''}\n`,
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

/** The hostname suffix `list-gyazo` narrows to. */
const GYAZO_HOST = 'gyazo.com';

/**
 * Prints the URLs held in the cache.
 *
 * One per line by default, deduplicated and sorted, because the useful thing
 * to do with this list is feed it to something else. Coverage goes to stderr
 * rather than stdout so that a pipe gets only URLs.
 */
function listUrls(args: string[], fixedHost?: string): number {
  let host = fixedHost;
  let withPage = false;
  let asJson = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--host' && fixedHost === undefined) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write('--host needs a hostname suffix, e.g. gyazo.com\n');
        return 2;
      }
      host = value;
      i += 1;
    } else if (arg === '--with-page') {
      withPage = true;
    } else if (arg === '--json') {
      asJson = true;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`unknown option: ${arg}\n`);
      return 2;
    } else {
      positional.push(arg);
    }
  }

  let project: string;
  try {
    project = resolveProjectUrl(positional[0]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const { index } = getIndex(project);
  const coverage = bodyCoverage(project, index);
  const rows = collectUrls(project, index, { host });

  if (coverage.known < coverage.total) {
    process.stderr.write(
      `warning: ${coverage.known} of ${coverage.total} page bodies have been ` +
        `read, so this is not the whole project. Run \`cosensecli crawl\` first.\n`,
    );
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else if (withPage) {
    for (const row of rows) {
      process.stdout.write(`${row.url}\t${row.title}\n`);
    }
  } else {
    // Deduplicated only in this form: the same image used on two pages is one
    // URL, and a caller asking for a plain list wants it once.
    const unique = [...new Set(rows.map((row) => row.url))].sort();
    for (const url of unique) process.stdout.write(`${url}\n`);
  }

  process.stderr.write(
    `${rows.length} found on ${coverage.known} pages` +
      `${host ? ` (host ${host})` : ''}\n`,
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
} else if (command === 'config') {
  process.exit(config(process.argv.slice(3)));
} else if (command === 'doctor') {
  process.exit(doctor());
} else if (command === 'crawl') {
  process.exit(crawl(process.argv.slice(3)));
} else if (command === 'list-urls') {
  process.exit(listUrls(process.argv.slice(3)));
} else if (command === 'list-gyazo') {
  process.exit(listUrls(process.argv.slice(3), GYAZO_HOST));
} else {
  process.stderr.write(`unknown command: ${command}\nSee \`cosensecli --help\`.\n`);
  process.exit(2);
}
