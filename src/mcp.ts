/**
 * A Model Context Protocol server over stdio, started with
 * `cosensecli --mcp-server`.
 *
 * Every tool is one read-only `cosense` command. The output is passed through
 * as the CLI printed it, because that output was already written to be read by
 * a model: browsePage returns Markdown with the metadata, the telomere and the
 * related pages around the body, which is more than a JSON dump of the same
 * page would say.
 *
 * There is no cache and no sync tool. The CLI holds no state, so every answer
 * is live, and there is no stale day to explain.
 *
 * stdout belongs to the protocol. Everything this file has to say to a human
 * goes to stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveCosenseBin } from './cosense';
import * as operations from './operations';
import type { RankParams } from './operations';
import { DEFAULT_PROJECT_ENV, defaultProjectUrl } from './defaults';
import { DEFAULT_CRAWL_BUDGET } from './pages';

function serverVersion(): string {
  // The published tarball always contains package.json, and dist/ sits one
  // level below it, so this holds both in the repository and once installed.
  return require('../package.json').version as string;
}

const DEFAULT_ORIGIN = 'https://scrapbox.io';

/**
 * The note every page- or project-addressed tool carries.
 *
 * A Cosense title can be a whole Japanese sentence, and its spaces become `_`
 * in the URL. A client that trims the URL at the first character that does not
 * look like a word ends up asking for a different page, and Cosense answers
 * that one rather than failing, so the mistake arrives as a plausible wrong
 * answer. Saying so in the description is the only place a connector will read
 * it: unlike the Agent Skill this CLI was built for, an MCP client gets no
 * procedure document.
 */
const URL_NOTE =
  'Pass the URL whole, from https:// up to the first whitespace. A Cosense ' +
  'title may be a long Japanese sentence whose spaces appear as _ in the URL, ' +
  'so do not cut it at a script or punctuation boundary.';

const PAGE_URL = z
  .string()
  .optional()
  .describe(
    `The full page URL, e.g. https://scrapbox.io/help-jp/Cosense. ${URL_NOTE} ` +
      'Give this or title, not both.',
  );

const TITLE = z
  .string()
  .optional()
  .describe(
    'The page title on its own, as search and the related page lists report ' +
      'it. Resolved against project_url, or against the default project. Give ' +
      'this or page_url, not both.',
  );

const PROJECT_URL = z
  .string()
  .optional()
  .describe(
    `The project URL, e.g. https://scrapbox.io/help-jp. ${URL_NOTE} ` +
      'Omit it to use the default project, which is what most questions mean.',
  );

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * What every tool returns. `isError` is what the audit log reads to tell a
 * refused call from an answered one, so both helpers share the shape rather
 * than one of them leaving the field off.
 */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * Turns one operation into a tool result.
 *
 * A tool must answer a bad argument rather than take the process down, and an
 * HTTP 401 or 403 from a private project is an ordinary answer here: the
 * server is allowed to run with no credentials at all, because a public
 * project reads fine without them.
 */
function answer(run: () => string): ToolResult {
  try {
    return textResult(run());
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Every tool call is announced on stderr, with what it was asked and how long
 * it took. stdout is the protocol, and a server that says nothing at all is
 * indistinguishable from one that has hung.
 *
 * Under systemd this is the audit trail: which tool, which arguments, and
 * whether it worked. The shape matches gyazocli's and hatebucli's, so one grep
 * reads all of them. Arguments are included, which means the page titles and
 * search terms a model asked about end up in the journal.
 *
 * A failure here is usually not a thrown error. The handlers turn a bad
 * argument or an HTTP error into a result carrying isError, because a tool
 * must answer rather than take the process down, so the flag is what says a
 * call did not work. Logging only thrown errors would have recorded every
 * 401 as ok.
 */
function logged<Args>(
  name: string,
  handler: (args: Args) => Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    const startedAt = Date.now();
    const given = Object.entries((args || {}) as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');
    try {
      const result = await handler(args);
      const outcome = result?.isError ? 'failed' : 'ok';
      console.error(
        `[cosense-mcp] ${name} ${outcome} ${Date.now() - startedAt}ms ${given}`.trimEnd(),
      );
      return result;
    } catch (error: any) {
      console.error(
        `[cosense-mcp] ${name} failed ${Date.now() - startedAt}ms ${given}`.trimEnd(),
        `- ${error?.message || error}`,
      );
      throw error;
    }
  };
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'cosensecli', version: serverVersion() },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'cosense_browse_page',
    {
      title: 'Read a Cosense page',
      description:
        'Read one Cosense (formerly Scrapbox) page. Returns the metadata, the ' +
        'icons, a per-author summary of who wrote which lines, any Infobox, the ' +
        'body, and the 1-hop and 2-hop related page titles, as Markdown. Start ' +
        'here once a page is identified, by title or by URL. The pageId and ' +
        'commitId it reports are what cosense_page_changes needs later.',
      inputSchema: { page_url: PAGE_URL, title: TITLE, project_url: PROJECT_URL },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_browse_page', async ({ page_url, title, project_url }) =>
      answer(() =>
        operations.browsePage({ pageUrl: page_url, title, projectUrl: project_url }),
      ),
    ),
  );

  server.registerTool(
    'cosense_browse_related_pages',
    {
      title: 'List the pages around a page',
      description:
        'The 1-hop and 2-hop neighbourhood of a page, as titles. Cosense is a ' +
        'knowledge graph, and a page often means little on its own: reading the ' +
        'neighbourhood is how the context around it shows up. A page with many ' +
        'backlinks or a high pageRank tends to act as a category. When the page ' +
        'defines an Infobox, this returns the literate database as a TSV table.',
      inputSchema: { page_url: PAGE_URL, title: TITLE, project_url: PROJECT_URL },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_browse_related_pages', async ({ page_url, title, project_url }) =>
      answer(() =>
        operations.browseRelatedPages({ pageUrl: page_url, title, projectUrl: project_url }),
      ),
    ),
  );

  server.registerTool(
    'cosense_search',
    {
      title: 'Search a project full text',
      description:
        'Full-text search across a project body. Terms are ANDed unless `or` is ' +
        'set. Do not stop at the first hit: follow the related pages of what it ' +
        'finds, because a single page rarely carries the whole context.',
      inputSchema: {
        project_url: PROJECT_URL,
        query: z.string().min(1).max(200).describe('The search terms.'),
        or: z.boolean().optional().describe('Match any term instead of all of them.'),
        sort: z
          .enum(['pageRank', 'updated'])
          .optional()
          .describe('Result order. Defaults to the CLI default.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_search', async ({ project_url, query, or, sort }) =>
      answer(() => operations.search({ projectUrl: project_url, query, or, sort })),
    ),
  );

  server.registerTool(
    'cosense_search_vector',
    {
      title: 'Search a project by meaning',
      description:
        'Vector search over page titles and the link notation inside bodies, ' +
        'not the full body text. Use it when the wording of the question is ' +
        'unlikely to be the wording on the page; use cosense_search when a ' +
        'literal string is what matters.',
      inputSchema: {
        project_url: PROJECT_URL,
        query: z.string().min(1).max(200).describe('What the page should be about.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_search_vector', async ({ project_url, query }) =>
      answer(() => operations.searchVector({ projectUrl: project_url, query })),
    ),
  );

  server.registerTool(
    'cosense_list_pages',
    {
      title: 'List the pages of a project',
      description:
        'The pages of a project, with the total count. Sorting by `linked` or ' +
        '`views` is how the pages that act as categories surface when nothing ' +
        'specific is known about the project yet.',
      inputSchema: {
        project_url: PROJECT_URL,
        sort: z
          .enum(['updated', 'created', 'accessed', 'linked', 'views', 'title'])
          .optional()
          .describe('Order. Defaults to updated.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 100.'),
        skip: z.number().int().min(0).optional().describe('Offset. Default 0.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_list_pages', async ({ project_url, sort, limit, skip }) =>
      answer(() => operations.listPages({ projectUrl: project_url, sort, limit, skip })),
    ),
  );

  server.registerTool(
    'cosense_page_changes',
    {
      title: 'See what changed on a page',
      description:
        'The edit history of a page, by pageId, explained in words: who changed ' +
        'what, including a rename. A page that has turned into a 404 or an empty ' +
        'page was probably renamed by a co-editor, and this is how to find out ' +
        'what it became. The pageId comes from cosense_browse_page.',
      inputSchema: {
        project_url: PROJECT_URL,
        page_id: z.string().min(1).describe('The pageId, from cosense_browse_page.'),
        since: z
          .string()
          .optional()
          .describe('Only commits after this commitId, from an earlier read.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_page_changes', async ({ project_url, page_id, since }) =>
      answer(() =>
        operations.pageChanges({ projectUrl: project_url, pageId: page_id, since }),
      ),
    ),
  );

  server.registerTool(
    'cosense_read_file_info',
    {
      title: 'Read an attached file',
      description:
        'The metadata of a file uploaded to Cosense, and the text extracted from ' +
        'it: the OCR of an image, the body of a PDF. Use it for a ' +
        'https://scrapbox.io/files/... URL found in a page body.',
      inputSchema: {
        file_url: z.string().min(1).describe('The file URL, e.g. https://scrapbox.io/files/<id>.png'),
        project_url: z
          .string()
          .optional()
          .describe('The project the file belongs to, when it is not public.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_read_file_info', async ({ file_url, project_url }) =>
      answer(() => operations.readFileInfo({ fileUrl: file_url, projectUrl: project_url })),
    ),
  );

  server.registerTool(
    'cosense_rank_pages',
    {
      title: 'Rank the pages of a project',
      description:
        'Order a whole project by one measure and return the top pages: by ' +
        'line count, character count, backlinks, views, or when they were ' +
        'written. This answers questions the search and list tools cannot, ' +
        'because Cosense itself will not sort by size, and asking it to is ' +
        'not an error there but a silent fall back to update order. Reads a ' +
        'local index of the project, refreshed when it is stale, so the first ' +
        'call on a large project takes a few seconds and later ones do not.',
      inputSchema: {
        project_url: PROJECT_URL,
        by: z
          .enum(['lines', 'chars', 'linked', 'links', 'views', 'updated', 'created', 'title'])
          .describe(
            'What to order by. `lines` and `chars` are page size. `linked` is ' +
              'how many pages link here, which is how the pages acting as ' +
              'categories surface. `links` is the opposite, how many pages ' +
              'this one points at, and is the expensive one: it lives in each ' +
              "page's body, so the project is read a bite at a time and the " +
              'answer says how much of it is known so far.',
          ),
        order: z
          .enum(['desc', 'asc'])
          .optional()
          .describe('Default: desc, except for title, which defaults to asc.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20.'),
        refresh: z
          .boolean()
          .optional()
          .describe('Walk the project again instead of using the local index.'),
        budget: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe(
            `Only for by: links. How many page bodies to read this call ` +
              `(default ${DEFAULT_CRAWL_BUDGET}). Call again to read more; ` +
              'nothing already known is read twice.',
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_rank_pages', async ({ project_url, by, order, limit, refresh, budget }) =>
      answer(() =>
        operations.rank({
          projectUrl: project_url,
          by: by as RankParams['by'],
          order,
          limit,
          refresh,
          budget,
        }),
      ),
    ),
  );

  server.registerTool(
    'cosense_list_projects',
    {
      title: 'List the projects I can read',
      description:
        'The projects the configured credentials belong to. Requires ' +
        'authentication: with none configured this answers 401, which is the ' +
        'expected result rather than a fault, since public projects are readable ' +
        'anonymously by every other tool here.',
      inputSchema: {
        origin: z
          .string()
          .optional()
          .describe(`The Cosense origin. Defaults to ${DEFAULT_ORIGIN}.`),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    logged('cosense_list_projects', async ({ origin }) =>
      answer(() => operations.listProjects({ origin })),
    ),
  );

  return server;
}

/**
 * Says on stderr which project a question with no project in it will be about.
 * Without this line, a default set to the wrong project looks like Cosense
 * having nothing to say on the subject.
 */
function reportDefaultProject(): void {
  let configured: string | undefined;
  try {
    configured = defaultProjectUrl();
  } catch (error) {
    // A malformed default is worth failing over: every tool call would fail
    // the same way, and the message would arrive as that page's problem.
    throw new Error(
      `${DEFAULT_PROJECT_ENV} is set but unusable. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (configured === undefined) {
    console.error(
      `cosensecli: no default project. Every tool call must name one; set ` +
        `${DEFAULT_PROJECT_ENV} to change that.`,
    );
    return;
  }
  console.error(`cosensecli: default project is ${configured}.`);
}

/**
 * Says on stderr what the server can reach, so a silent 401 is not a surprise.
 *
 * This is a snapshot of the moment the server started, not a standing fact.
 * Credentials are read by the child process, and there is a fresh child per
 * tool call, so a login performed while this server runs takes effect on the
 * next call. The line says so, because a server that reported "no credentials"
 * at boot would otherwise look like the reason a later call still failed.
 */
function reportCredentialState(): void {
  if (process.env.COSENSE_PAT && process.env.COSENSE_PAT.trim() !== '') {
    console.error('cosensecli: using COSENSE_PAT from the environment.');
    return;
  }
  const settings = path.join(os.homedir(), '.cosense', 'settings.json');
  if (fs.existsSync(settings)) {
    console.error(`cosensecli: using credentials from ${settings}.`);
    return;
  }
  console.error(
    'cosensecli: no credentials configured at startup. Public projects still ' +
      'read fine; a private one answers 401. `cosense login <origin>` takes ' +
      'effect on the next tool call, with no restart of this server.',
  );
}

export async function runMcpServer(): Promise<void> {
  // Fail at startup rather than on the first tool call, where the message
  // would arrive as one tool's error and look like a problem with that page.
  const bin = resolveCosenseBin();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `the cosense CLI was not found at ${bin}. Install @helpfeel/cosense-cli, ` +
        'or point COSENSECLI_COSENSE_BIN at a checkout.',
    );
  }

  reportDefaultProject();
  reportCredentialState();

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('cosense MCP server ready on stdio.');
}
