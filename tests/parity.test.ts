/**
 * The two front ends answer alike.
 *
 * This is the claim the shared operations module exists to make true, and the
 * only way it stays true is by being checked: a tool and a command that drift
 * apart do so silently, since each one's own tests keep passing.
 */
import { expect, test } from 'vitest';
import { createTempWorkspace, runCli, runMcp, stubCalls, toolText } from './helpers';

const ENV = { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki' };

/** One capability, named the two ways it is reachable. */
const PAIRS: {
  what: string;
  cli: string[];
  tool: { name: string; arguments: Record<string, unknown> };
  replies?: Record<string, string>;
}[] = [
  {
    what: 'reading a page',
    cli: ['read', '地図 と AI'],
    tool: { name: 'cosense_browse_page', arguments: { title: '地図 と AI' } },
    replies: { browsePage: '# 地図 と AI\n\n本文' },
  },
  {
    what: 'the pages around one',
    cli: ['related', '地図'],
    tool: { name: 'cosense_browse_related_pages', arguments: { title: '地図' } },
  },
  {
    what: 'full-text search',
    cli: ['search', '地図', '--or', '--sort', 'updated'],
    tool: {
      name: 'cosense_search',
      arguments: { query: '地図', or: true, sort: 'updated' },
    },
  },
  {
    what: 'search by meaning',
    cli: ['search-vector', '地図'],
    tool: { name: 'cosense_search_vector', arguments: { query: '地図' } },
  },
  {
    what: 'the page list',
    cli: ['pages', '--sort', 'linked', '--limit', '5'],
    tool: { name: 'cosense_list_pages', arguments: { sort: 'linked', limit: 5 } },
  },
  {
    what: 'the history of a page',
    cli: ['changes', 'abc123', '--since', 'commit9'],
    tool: {
      name: 'cosense_page_changes',
      arguments: { page_id: 'abc123', since: 'commit9' },
    },
  },
  {
    what: 'an attachment',
    cli: ['file', 'https://scrapbox.io/files/abc.png'],
    tool: {
      name: 'cosense_read_file_info',
      arguments: { file_url: 'https://scrapbox.io/files/abc.png' },
    },
  },
  {
    what: 'the projects reachable',
    cli: ['projects'],
    tool: { name: 'cosense_list_projects', arguments: {} },
  },
];

for (const pair of PAIRS) {
  test(`${pair.what}: the command and the tool run the same thing`, async () => {
    const viaCli = createTempWorkspace();
    const cli = runCli(viaCli, pair.cli, { env: ENV, replies: pair.replies });

    const viaMcp = createTempWorkspace();
    const { responses } = await runMcp(viaMcp, [pair.tool], {
      env: ENV,
      replies: pair.replies,
    });

    expect(cli.status).toBe(0);
    expect(responses[0].result.isError).toBeUndefined();

    // The same cosense invocation, argument for argument.
    expect(stubCalls(viaCli)).toEqual(stubCalls(viaMcp));
    // And the same answer, up to the newline the CLI adds for a terminal.
    expect(cli.stdout.trimEnd()).toBe(toolText(responses[0]).trimEnd());
  });
}

test('ranking: the command and the tool answer alike', async () => {
  const listing = {
    count: 2,
    pages: [
      { id: 'a', title: 'short', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 1, views: 2, linesCount: 4, charsCount: 40, pin: 0 },
      { id: 'b', title: 'long', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 3, views: 4, linesCount: 191, charsCount: 5176, pin: 0 },
    ],
  };
  const replies = { listPages: JSON.stringify(listing) };

  const viaCli = createTempWorkspace();
  const cli = runCli(viaCli, ['rank', '--by', 'lines', '--limit', '2'], {
    env: { ...ENV, COSENSECLI_CACHE_DIR: `${viaCli.rootDir}/cache` },
    replies,
  });

  const viaMcp = createTempWorkspace();
  const { responses } = await runMcp(
    viaMcp,
    [{ name: 'cosense_rank_pages', arguments: { by: 'lines', limit: 2 } }],
    { env: { ...ENV, COSENSECLI_CACHE_DIR: `${viaMcp.rootDir}/cache` }, replies },
  );

  // The index line carries an age, which differs by the milliseconds between
  // the two runs, so it is the one line not compared.
  const withoutAge = (text: string) =>
    text
      .trimEnd()
      .split('\n')
      .filter((line) => !line.startsWith('index: '))
      .join('\n');

  expect(withoutAge(cli.stdout)).toBe(withoutAge(toolText(responses[0])));
});

test('a refusal reads alike on both sides', async () => {
  const viaCli = createTempWorkspace();
  const cli = runCli(viaCli, ['read', '秘密'], {
    env: ENV,
    replies: { browsePage: 'EXIT:1:HTTP 401 Unauthorized' },
  });

  const viaMcp = createTempWorkspace();
  const { responses } = await runMcp(
    viaMcp,
    [{ name: 'cosense_browse_page', arguments: { title: '秘密' } }],
    { env: ENV, replies: { browsePage: 'EXIT:1:HTTP 401 Unauthorized' } },
  );

  // One exits non-zero and the other sets isError, but the message a person
  // or a model has to act on is the same text.
  expect(cli.status).toBe(1);
  expect(responses[0].result.isError).toBe(true);
  expect(cli.stderr.trimEnd()).toBe(toolText(responses[0]).trimEnd());
});
