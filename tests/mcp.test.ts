/**
 * The MCP server, driven over a pipe with JSON-RPC, against a stub cosense CLI.
 * Nothing here reaches Cosense.
 */
import { expect, test } from 'vitest';
import { createTempWorkspace, runMcp, stubCalls, toolText } from './helpers';

const EXPECTED_TOOLS = [
  'cosense_browse_page',
  'cosense_browse_related_pages',
  'cosense_list_pages',
  'cosense_list_projects',
  'cosense_page_changes',
  'cosense_read_file_info',
  'cosense_search',
  'cosense_search_vector',
];

test('the server introduces itself and lists read-only tools', async () => {
  const ws = createTempWorkspace();
  const { initialize, tools, stderr } = await runMcp(ws, []);

  expect(initialize.serverInfo.name).toBe('cosensecli');
  expect(initialize.serverInfo.version).toBe(require('../package.json').version);
  expect(tools.map((tool: any) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  }
  expect(stderr).toContain('cosense MCP server ready on stdio.');
});

test('it starts without credentials, and says which projects that leaves reachable', async () => {
  const ws = createTempWorkspace();
  const { tools, stderr } = await runMcp(ws, []);

  expect(tools.length).toBe(EXPECTED_TOOLS.length);
  expect(stderr).toContain('no credentials configured');
  expect(stderr).toContain('Public projects still read fine');
});

test('COSENSE_PAT is reported instead, when it is set', async () => {
  const ws = createTempWorkspace();
  const { stderr } = await runMcp(ws, [], { env: { COSENSE_PAT: 'secret-token' } });

  expect(stderr).toContain('using COSENSE_PAT from the environment');
  // The token itself must never be echoed.
  expect(stderr).not.toContain('secret-token');
});

test('cosense_browse_page passes the URL through whole', async () => {
  const ws = createTempWorkspace();
  const pageUrl = 'https://scrapbox.io/yuiseki/長い_日本語の_タイトル';

  const { responses } = await runMcp(
    ws,
    [{ name: 'cosense_browse_page', arguments: { page_url: pageUrl } }],
    { replies: { browsePage: '# 長い 日本語の タイトル\n\n本文' } },
  );

  expect(stubCalls(ws)).toEqual([['browsePage', pageUrl]]);
  expect(toolText(responses[0])).toContain('本文');
});

test('cosense_search builds the flags the CLI expects', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [
    {
      name: 'cosense_search',
      arguments: {
        project_url: 'https://scrapbox.io/yuiseki',
        query: '地図 AI',
        or: true,
        sort: 'updated',
      },
    },
  ]);

  expect(stubCalls(ws)).toEqual([
    ['searchFullText', 'https://scrapbox.io/yuiseki', '地図 AI', '--or', '--sort', 'updated'],
  ]);
});

test('an omitted option is omitted, not passed as undefined', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [
    {
      name: 'cosense_search',
      arguments: { project_url: 'https://scrapbox.io/yuiseki', query: '地図' },
    },
  ]);

  expect(stubCalls(ws)).toEqual([
    ['searchFullText', 'https://scrapbox.io/yuiseki', '地図'],
  ]);
});

test('cosense_list_pages passes the numeric options as strings', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [
    {
      name: 'cosense_list_pages',
      arguments: {
        project_url: 'https://scrapbox.io/yuiseki',
        sort: 'linked',
        limit: 20,
        skip: 40,
      },
    },
  ]);

  expect(stubCalls(ws)).toEqual([
    ['listPages', 'https://scrapbox.io/yuiseki', '--sort', 'linked', '--limit', '20', '--skip', '40'],
  ]);
});

test('cosense_page_changes takes --since only when given', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [
    {
      name: 'cosense_page_changes',
      arguments: { project_url: 'https://scrapbox.io/yuiseki', page_id: 'abc123' },
    },
    {
      name: 'cosense_page_changes',
      arguments: {
        project_url: 'https://scrapbox.io/yuiseki',
        page_id: 'abc123',
        since: 'commit9',
      },
    },
  ]);

  expect(stubCalls(ws)).toEqual([
    ['browsePageChanges', 'https://scrapbox.io/yuiseki', 'abc123'],
    ['browsePageChanges', 'https://scrapbox.io/yuiseki', 'abc123', '--since', 'commit9'],
  ]);
});

test('cosense_list_projects defaults to scrapbox.io', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [{ name: 'cosense_list_projects', arguments: {} }]);

  expect(stubCalls(ws)).toEqual([['listProjects', 'https://scrapbox.io']]);
});

test('an HTTP error from the CLI comes back as an error on that call, and the server keeps going', async () => {
  const ws = createTempWorkspace();

  const { responses } = await runMcp(
    ws,
    [
      {
        name: 'cosense_browse_page',
        arguments: { page_url: 'https://scrapbox.io/private/secret' },
      },
      {
        name: 'cosense_browse_page',
        arguments: { page_url: 'https://scrapbox.io/yuiseki/ok' },
      },
    ],
    {
      replies: {
        browsePage: 'EXIT:1:HTTP 401 Unauthorized',
      },
    },
  );

  expect(responses[0].result.isError).toBe(true);
  expect(toolText(responses[0])).toContain('HTTP 401');
  // The second call still gets an answer: one bad page does not end the session.
  expect(responses[1].result).toBeDefined();
  expect(stubCalls(ws).length).toBe(2);
});

test('a bad argument is answered, not fatal', async () => {
  const ws = createTempWorkspace();

  const { responses, tools } = await runMcp(ws, [
    { name: 'cosense_browse_page', arguments: {} },
  ]);

  expect(tools.length).toBe(EXPECTED_TOOLS.length);
  expect(responses[0].result?.isError ?? responses[0].error).toBeTruthy();
});

const DEFAULT_PROJECT = { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki' };

test('with a default project, a question need not name one', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [{ name: 'cosense_search', arguments: { query: '地図' } }], {
    env: DEFAULT_PROJECT,
  });

  expect(stubCalls(ws)).toEqual([
    ['searchFullText', 'https://scrapbox.io/yuiseki', '地図'],
  ]);
});

test('a named project still wins over the default', async () => {
  const ws = createTempWorkspace();

  await runMcp(
    ws,
    [
      {
        name: 'cosense_search',
        arguments: { project_url: 'https://scrapbox.io/help-jp', query: '地図' },
      },
    ],
    { env: DEFAULT_PROJECT },
  );

  expect(stubCalls(ws)).toEqual([
    ['searchFullText', 'https://scrapbox.io/help-jp', '地図'],
  ]);
});

test('a page can be asked for by title alone', async () => {
  const ws = createTempWorkspace();

  await runMcp(
    ws,
    [{ name: 'cosense_browse_page', arguments: { title: '地図 と AI' } }],
    { env: DEFAULT_PROJECT },
  );

  expect(stubCalls(ws)).toEqual([
    ['browsePage', 'https://scrapbox.io/yuiseki/地図_と_AI'],
  ]);
});

test('the startup line says which project a bare question is about', async () => {
  const ws = createTempWorkspace();
  const { stderr } = await runMcp(ws, [], { env: DEFAULT_PROJECT });

  expect(stderr).toContain('default project is https://scrapbox.io/yuiseki');
});

test('without a default, the startup line says every call must name one', async () => {
  const ws = createTempWorkspace();
  const { stderr } = await runMcp(ws, []);

  expect(stderr).toContain('no default project');
});

test('a malformed default fails at startup rather than on every call', async () => {
  const ws = createTempWorkspace();
  const { tools, stderr } = await runMcp(ws, [], {
    env: { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki/地図' },
  });

  expect(tools).toEqual([]);
  expect(stderr).toContain('must be a project URL, not a page URL');
});

test('with no default and no project, the call says how to set one', async () => {
  const ws = createTempWorkspace();

  const { responses } = await runMcp(ws, [
    { name: 'cosense_search', arguments: { query: '地図' } },
  ]);

  expect(responses[0].result.isError).toBe(true);
  expect(toolText(responses[0])).toContain('COSENSECLI_DEFAULT_PROJECT');
  // Nothing ran: the problem was found before a process was started.
  expect(stubCalls(ws)).toEqual([]);
});

test('cosense_list_projects follows the default project origin', async () => {
  const ws = createTempWorkspace();

  await runMcp(ws, [{ name: 'cosense_list_projects', arguments: {} }], {
    env: { COSENSECLI_DEFAULT_PROJECT: 'https://cosense.example.com/team' },
  });

  expect(stubCalls(ws)).toEqual([['listProjects', 'https://cosense.example.com']]);
});

test('every tool call is logged for the journal, with its arguments', async () => {
  const ws = createTempWorkspace();

  const { stderr } = await runMcp(
    ws,
    [{ name: 'cosense_search', arguments: { query: '地図' } }],
    { env: DEFAULT_PROJECT },
  );

  expect(stderr).toMatch(/\[cosense-mcp\] cosense_search ok \d+ms query="地図"/);
});

test('a refused call is logged as failed, not as ok', async () => {
  const ws = createTempWorkspace();

  // The handlers answer an HTTP error rather than throwing, so the audit line
  // has to read isError. Matching only thrown errors logged every 401 as ok.
  const { stderr } = await runMcp(
    ws,
    [{ name: 'cosense_browse_page', arguments: { title: '秘密' } }],
    {
      env: DEFAULT_PROJECT,
      replies: { browsePage: 'EXIT:1:HTTP 401 Unauthorized' },
    },
  );

  expect(stderr).toMatch(/\[cosense-mcp\] cosense_browse_page failed \d+ms/);
  expect(stderr).not.toMatch(/cosense_browse_page ok/);
});

test('a call refused before a process starts is logged too', async () => {
  const ws = createTempWorkspace();

  const { stderr } = await runMcp(ws, [
    { name: 'cosense_search', arguments: { query: '地図' } },
  ]);

  expect(stderr).toMatch(/\[cosense-mcp\] cosense_search failed \d+ms/);
  expect(stubCalls(ws)).toEqual([]);
});
