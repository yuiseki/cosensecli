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
import { CosenseCommandError, resolveCosenseBin, runCosense } from './cosense';

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
  .min(1)
  .describe(`The full page URL, e.g. https://scrapbox.io/help-jp/Cosense. ${URL_NOTE}`);

const PROJECT_URL = z
  .string()
  .min(1)
  .describe(`The project URL, e.g. https://scrapbox.io/help-jp. ${URL_NOTE}`);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * Runs one command and turns a failure into an error on that call.
 *
 * A tool must answer a bad argument rather than take the process down, and an
 * HTTP 401 or 403 from a private project is an ordinary answer here: the
 * server is allowed to run with no credentials at all, because a public
 * project reads fine without them.
 */
function call(command: string, args: string[]) {
  try {
    const { stdout } = runCosense(command, args);
    const text = stdout.trim();
    return textResult(text === '' ? '(the command returned nothing)' : stdout);
  } catch (error) {
    if (error instanceof CosenseCommandError) {
      return errorResult(error);
    }
    return errorResult(error);
  }
}

/** Appends `flag value` only when the value was given. */
function optional(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(flag, String(value));
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
        'here when a page URL is known. The pageId and commitId it reports are ' +
        'what cosense_page_changes needs later.',
      inputSchema: { page_url: PAGE_URL },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_url }) => call('browsePage', [page_url]),
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
      inputSchema: { page_url: PAGE_URL },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page_url }) => call('browseRelatedPages', [page_url]),
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
    async ({ project_url, query, or, sort }) => {
      const args = [project_url, query];
      if (or) args.push('--or');
      optional(args, '--sort', sort);
      return call('searchFullText', args);
    },
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
    async ({ project_url, query }) => call('searchVector', [project_url, query]),
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
    async ({ project_url, sort, limit, skip }) => {
      const args = [project_url];
      optional(args, '--sort', sort);
      optional(args, '--limit', limit);
      optional(args, '--skip', skip);
      return call('listPages', args);
    },
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
    async ({ project_url, page_id, since }) => {
      const args = [project_url, page_id];
      optional(args, '--since', since);
      return call('browsePageChanges', args);
    },
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
    async ({ file_url, project_url }) => {
      const args = [file_url];
      optional(args, '--project', project_url);
      return call('readFileInfo', args);
    },
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
    async ({ origin }) => call('listProjects', [origin ?? DEFAULT_ORIGIN]),
  );

  return server;
}

/** Says on stderr what the server can reach, so a silent 401 is not a surprise. */
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
    'cosensecli: no credentials configured. Public projects still read fine; ' +
      'a private one answers 401. Run `cosense login <origin>` to add one.',
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

  reportCredentialState();

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('cosense MCP server ready on stdio.');
}
