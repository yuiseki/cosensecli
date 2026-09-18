/**
 * The index cache and the rankings it makes possible.
 *
 * Nothing here reaches Cosense: COSENSECLI_COSENSE_BIN points at a stub, and
 * COSENSECLI_CACHE_DIR at a temporary directory, so the walk and the writes
 * are both observable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTempWorkspace, type Workspace } from './helpers';

const PROJECT = 'https://scrapbox.io/yuiseki';

let ws: Workspace;
let calls: string[][];

/**
 * Stands in for `runCosense`, so the walk can be driven without a process.
 * Each call records its argv and returns the next canned page of results.
 */
function stubRunner(batches: any[]) {
  let index = 0;
  return (command: string, args: string[] = []) => {
    calls.push([command, ...args]);
    const payload = batches[Math.min(index, batches.length - 1)];
    index += 1;
    return { stdout: JSON.stringify(payload), stderr: '' };
  };
}

/**
 * A page as `cosense listPages` actually prints one.
 *
 * The timestamps are the enriched form, not unix seconds. Writing this fixture
 * with numbers is what hid the bug: Number() turned every real timestamp into
 * 0, and the tests passed because they were asking about a shape the CLI does
 * not produce.
 */
function page(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `page-${id}`,
    updated: '2025-03-12T19:13+09:00 (2 years ago)',
    created: '2018-07-10T07:40+09:00 (8 years ago)',
    linked: 0,
    views: 0,
    linesCount: 1,
    charsCount: 10,
    pin: 0,
    ...overrides,
  };
}

beforeEach(() => {
  ws = createTempWorkspace();
  calls = [];
  process.env.COSENSECLI_CACHE_DIR = path.join(ws.rootDir, 'cache');
});

afterEach(() => {
  delete process.env.COSENSECLI_CACHE_DIR;
});

/** Runs the body with a stub runner, which the callers pass down explicitly. */
async function withStub(batches: any[], run: (runner: any) => void | Promise<void>) {
  await run(stubRunner(batches));
}

test('reading never creates the cache directory', async () => {
  const { loadIndex } = await import('../src/cache');
  const dir = process.env.COSENSECLI_CACHE_DIR as string;

  expect(loadIndex(PROJECT)).toBeNull();
  // A sandbox with a read-only home must survive a miss. hatebucli learned
  // this the hard way: an mkdir on the way to a file that is not there took
  // the whole tool call down.
  expect(fs.existsSync(dir)).toBe(false);
});

test('a walk pages through the project and keeps what the ranking needs', async () => {
  const { fetchIndex } = await import('../src/pages');
  const first = { count: 1002, pages: Array.from({ length: 1000 }, (_, i) => page(`a${i}`)) };
  const second = { count: 1002, pages: [page('b0'), page('b1')] };

  await withStub([first, second], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    expect(index.count).toBe(1002);
    expect(index.pages.length).toBe(1002);
    expect(index.truncated).toBe(false);
  });

  expect(calls).toEqual([
    ['listPages', PROJECT, '--sort', 'title', '--limit', '1000', '--skip', '0'],
    ['listPages', PROJECT, '--sort', 'title', '--limit', '1000', '--skip', '1000'],
  ]);
});

test('the walk asks for title order, because update order moves under it', async () => {
  const { fetchIndex } = await import('../src/pages');

  await withStub([{ count: 1, pages: [page('a')] }], (runner) => {
    fetchIndex(PROJECT, { runner });
  });

  // A page edited mid-walk would jump to the front of an updated-ordered list
  // and push an unseen page past the boundary. Title order does not move.
  expect(calls[0]).toContain('--sort');
  expect(calls[0][calls[0].indexOf('--sort') + 1]).toBe('title');
});

test('a page seen twice across requests is kept once', async () => {
  const { fetchIndex } = await import('../src/pages');
  const first = { count: 1001, pages: Array.from({ length: 1000 }, (_, i) => page(`a${i}`)) };
  // a999 slid across the boundary while the walk was running.
  const second = { count: 1001, pages: [page('a999'), page('b0')] };

  await withStub([first, second], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    expect(index.pages.length).toBe(1001);
    expect(index.pages.filter((entry) => entry.id === 'a999').length).toBe(1);
  });
});

test('a second read is answered from the cache, without asking again', async () => {
  const { getIndex } = await import('../src/pages');
  const batch = { count: 1, pages: [page('a')] };

  await withStub([batch], (runner) => {
    const first = getIndex(PROJECT, { runner });
    expect(first.refreshed).toBe(true);

    const second = getIndex(PROJECT, { runner });
    expect(second.refreshed).toBe(false);
    expect(second.index.pages.length).toBe(1);
  });

  expect(calls.length).toBe(1);
});

test('an index older than the window is refetched', async () => {
  const { getIndex } = await import('../src/pages');
  const { loadIndex, saveIndex } = await import('../src/cache');

  await withStub([{ count: 1, pages: [page('a')] }], (runner) => {
    getIndex(PROJECT, { runner });
    const stored = loadIndex(PROJECT)!;
    saveIndex(PROJECT, {
      ...stored,
      fetchedAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    const again = getIndex(PROJECT, { maxAgeSeconds: 60, runner });
    expect(again.refreshed).toBe(true);
  });

  expect(calls.length).toBe(2);
});

test('refresh forces a walk even when the cache is fresh', async () => {
  const { getIndex } = await import('../src/pages');

  await withStub([{ count: 1, pages: [page('a')] }], (runner) => {
    getIndex(PROJECT, { runner });
    getIndex(PROJECT, { refresh: true, runner });
  });

  expect(calls.length).toBe(2);
});

test('a walk that hits its request budget says it is partial', async () => {
  const { fetchIndex } = await import('../src/pages');
  const full = { count: 5000, pages: Array.from({ length: 1000 }, (_, i) => page(`x${i}`)) };

  await withStub([full, full, full], (runner) => {
    const index = fetchIndex(PROJECT, { maxRequests: 2, runner });
    // The ids repeat across the canned batches, so the count is what matters:
    // a ranking must know it is looking at part of the project.
    expect(index.truncated).toBe(true);
    expect(index.count).toBe(5000);
  });
});

test('ranking by lines is what the API will not do', async () => {
  const { fetchIndex, rankPages } = await import('../src/pages');
  const batch = {
    count: 3,
    pages: [
      page('a', { title: 'short', linesCount: 4 }),
      page('b', { title: 'long', linesCount: 191 }),
      page('c', { title: 'middle', linesCount: 37 }),
    ],
  };

  await withStub([batch], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    expect(rankPages(index, 'lines').map((entry) => entry.title)).toEqual([
      'long',
      'middle',
      'short',
    ]);
    expect(rankPages(index, 'lines', { order: 'asc' }).map((entry) => entry.title)).toEqual([
      'short',
      'middle',
      'long',
    ]);
  });
});

test('a pinned page is not floated to the front of a ranking', async () => {
  const { fetchIndex, rankPages } = await import('../src/pages');
  const batch = {
    count: 2,
    pages: [
      page('a', { title: 'pinned but short', linesCount: 2, pin: 100 }),
      page('b', { title: 'long', linesCount: 500 }),
    ],
  };

  await withStub([batch], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    // The API floats pinned pages for its own sorts, which is why a small
    // limit there returns the same pages whatever the sort. A ranking that
    // did the same would not be a ranking.
    expect(rankPages(index, 'lines')[0].title).toBe('long');
  });
});

test('ranking by backlinks and by title both work, with title ascending by default', async () => {
  const { fetchIndex, rankPages } = await import('../src/pages');
  const batch = {
    count: 3,
    pages: [
      page('a', { title: 'ぜ', linked: 1 }),
      page('b', { title: 'あ', linked: 334 }),
      page('c', { title: 'か', linked: 178 }),
    ],
  };

  await withStub([batch], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    expect(rankPages(index, 'linked').map((e) => e.linked)).toEqual([334, 178, 1]);
    expect(rankPages(index, 'title').map((e) => e.title)).toEqual(['あ', 'か', 'ぜ']);
  });
});

test('the index is written atomically, so a reader never sees half a file', async () => {
  const { getIndex } = await import('../src/pages');
  const { projectCacheDir } = await import('../src/cache');

  await withStub([{ count: 1, pages: [page('a')] }], (runner) => {
    getIndex(PROJECT, { runner });
  });

  const dir = projectCacheDir(PROJECT);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  expect(leftovers).toEqual([]);
  expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);
});

test('the cache is keyed by host as well as project name', async () => {
  const { projectCacheDir } = await import('../src/cache');

  const a = projectCacheDir('https://scrapbox.io/team');
  const b = projectCacheDir('https://cosense.example.com/team');

  // The same name on a self-hosted instance is a different project, and
  // answering one with the other's pages would be silent.
  expect(a).not.toBe(b);
});

test('the enriched timestamp the CLI prints is kept whole, and parsed for ordering', async () => {
  const { fetchIndex } = await import('../src/pages');
  const batch = {
    count: 2,
    pages: [
      page('a', { updated: '2025-03-12T19:13+09:00 (2 years ago)' }),
      page('b', { updated: '2026-09-16T11:00+09:00 (1 hour ago)' }),
    ],
  };

  await withStub([batch], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    const [a, b] = index.pages;

    // The token is what a cached page is checked against, so it must survive
    // exactly as printed rather than as something derived from it.
    expect(a.updated).toBe('2025-03-12T19:13+09:00 (2 years ago)');
    // Never 0. The whole validation axis rested on this and was silently dead.
    expect(a.updatedAt).toBe(Date.parse('2025-03-12T19:13+09:00'));
    expect(b.updatedAt!).toBeGreaterThan(a.updatedAt!);
  });
});

test('a timestamp that cannot be read is null, not zero', async () => {
  const { fetchIndex, rankPages, rankableCount } = await import('../src/pages');
  const batch = {
    count: 2,
    pages: [
      page('a', { title: 'dated', updated: '2025-03-12T19:13+09:00 (2 years ago)' }),
      page('b', { title: 'undated', updated: undefined }),
    ],
  };

  await withStub([batch], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    expect(index.pages.find((e) => e.title === 'undated')!.updatedAt).toBeNull();

    // Ranked out rather than sorted as epoch zero, which would have placed it
    // at one end of the list as though that were its measurement.
    expect(rankPages(index, 'updated').map((e) => e.title)).toEqual(['dated']);
    expect(rankableCount(index, 'updated')).toBe(1);
    expect(rankableCount(index, 'lines')).toBe(2);
  });
});

test('raw unix seconds are still accepted, in case the CLI stops enriching', async () => {
  const { fetchIndex } = await import('../src/pages');

  await withStub([{ count: 1, pages: [page('a', { updated: 1531180816 })] }], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    expect(index.pages[0].updatedAt).toBe(1531180816 * 1000);
  });
});

test('an index written by an older build is discarded, not reinterpreted', async () => {
  const { loadIndex, saveIndex } = await import('../src/cache');

  saveIndex(PROJECT, {
    version: 1,
    project: PROJECT,
    fetchedAt: new Date().toISOString(),
    count: 1,
    truncated: false,
    pages: [],
  } as any);

  // Version 1 stored `updated` as a number that was always 0. Reading it as
  // though it were version 2 would treat every page as validated.
  expect(loadIndex(PROJECT)).toBeNull();
});

test('a crawl reads page bodies up to its budget, keeping links and URLs but no text', async () => {
  const { fetchIndex, crawlLinks, knownLinkCounts } = await import('../src/pages');
  const { loadPage } = await import('../src/cache');
  const listing = {
    count: 3,
    pages: [page('a', { title: 'one' }), page('b', { title: 'two' }), page('c', { title: 'three' })],
  };

  await withStub([listing], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    const bodyRunner = (command: string, args: string[] = []) => {
      calls.push([command, ...args]);
      return { stdout: JSON.stringify({ links: ['x', 'y'] }), stderr: '' };
    };

    const report = crawlLinks(PROJECT, index, { budget: 2, delayMs: 0, runner: bodyRunner });
    expect(report.fetched).toBe(2);
    expect(report.remaining).toBe(1);
    expect(report.current).toBe(0);

    // The body text is not kept: what is extracted from it is. Holding the
    // rendering would be the thing this page's own `updated` could not vouch
    // for, since the related list moves when other pages change.
    const cached = loadPage(PROJECT, 'a')!;
    expect(cached.links).toEqual(['x', 'y']);
    expect(Object.keys(cached).sort()).toEqual([
      'cachedAt',
      'id',
      'links',
      'title',
      'updated',
      'urls',
    ]);
    expect(cached).not.toHaveProperty('lines');
    expect(cached).not.toHaveProperty('text');

    expect(knownLinkCounts(PROJECT, index).length).toBe(2);
  });
});

test('a second crawl only reads what is not already current', async () => {
  const { fetchIndex, crawlLinks } = await import('../src/pages');
  const listing = { count: 2, pages: [page('a'), page('b')] };

  await withStub([listing], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    const body = () => ({ stdout: JSON.stringify({ links: [] }), stderr: '' });

    crawlLinks(PROJECT, index, { budget: 10, delayMs: 0, runner: body });
    const second = crawlLinks(PROJECT, index, { budget: 10, delayMs: 0, runner: body });

    expect(second.fetched).toBe(0);
    expect(second.current).toBe(2);
    expect(second.remaining).toBe(0);
  });
});

test('an edited page is read again, because its token moved', async () => {
  const { fetchIndex, crawlLinks, knownLinkCounts } = await import('../src/pages');
  const before = { count: 1, pages: [page('a', { updated: '2025-01-01T00:00+09:00 (a year ago)' })] };
  const after = { count: 1, pages: [page('a', { updated: '2026-09-16T11:00+09:00 (1 hour ago)' })] };

  await withStub([before], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    crawlLinks(PROJECT, index, {
      budget: 10,
      delayMs: 0,
      runner: () => ({ stdout: JSON.stringify({ links: ['old'] }), stderr: '' }),
    });
    expect(knownLinkCounts(PROJECT, index)[0].links).toBe(1);
  });

  await withStub([after], (runner) => {
    const index = fetchIndex(PROJECT, { refresh: true, runner });
    // The cached copy is not current any more, so it is not counted until it
    // has been read again. A merge would have kept the old links alive.
    expect(knownLinkCounts(PROJECT, index).length).toBe(0);

    crawlLinks(PROJECT, index, {
      budget: 10,
      delayMs: 0,
      runner: () => ({ stdout: JSON.stringify({ links: ['a', 'b', 'c'] }), stderr: '' }),
    });
    expect(knownLinkCounts(PROJECT, index)[0].links).toBe(3);
  });
});

test('a page that cannot be read stays unknown rather than counting as zero links', async () => {
  const { fetchIndex, crawlLinks, knownLinkCounts } = await import('../src/pages');

  await withStub([{ count: 1, pages: [page('a')] }], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    const report = crawlLinks(PROJECT, index, {
      budget: 10,
      delayMs: 0,
      runner: () => {
        throw new Error('HTTP 404');
      },
    });

    expect(report.failed).toBe(1);
    // Nothing was written, so the page is absent from the counts rather than
    // present with zero. A zero would rank as "links to nothing", which is a
    // claim this never established.
    expect(knownLinkCounts(PROJECT, index)).toEqual([]);
  });
});

test('URLs are pulled out of the body, whatever notation wraps them', async () => {
  const { extractUrls } = await import('../src/pages');

  const urls = extractUrls([
    { text: 'bare https://gyazo.com/aaa here' },
    { text: '[https://gyazo.com/bbb]' },
    { text: '[https://example.com/c ラベル付き]' },
    { text: 'https://gyazo.com/aaa' }, // the same one again
    { text: 'no url at all' },
    { text: undefined },
  ]);

  expect(urls).toEqual([
    'https://gyazo.com/aaa',
    'https://gyazo.com/bbb',
    'https://example.com/c',
  ]);
});

test('a host filter matches subdomains, which are the same service renamed', async () => {
  const { fetchIndex, crawlLinks, collectUrls } = await import('../src/pages');

  await withStub([{ count: 1, pages: [page('a', { title: 'one' })] }], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    crawlLinks(PROJECT, index, {
      budget: 1,
      delayMs: 0,
      runner: () => ({
        stdout: JSON.stringify({
          links: [],
          lines: [
            { text: 'https://gyazo.com/aaa' },
            { text: 'https://i.gyazo.com/bbb.png' },
            { text: 'https://nota.gyazo.com/ccc/raw' },
            { text: 'https://notgyazo.com/ddd' },
            { text: 'https://example.com/e' },
          ],
        }),
        stderr: '',
      }),
    });

    const gyazo = collectUrls(PROJECT, index, { host: 'gyazo.com' }).map((r) => r.url);
    // i. and nota. are Gyazo; notgyazo.com only looks like it, and an exact
    // hostname comparison would have missed the first two.
    expect(gyazo).toEqual([
      'https://gyazo.com/aaa',
      'https://i.gyazo.com/bbb.png',
      'https://nota.gyazo.com/ccc/raw',
    ]);
    expect(collectUrls(PROJECT, index).length).toBe(5);
  });
});

test('a page cached before urls existed is read again, not reported as having none', async () => {
  const { fetchIndex, collectUrls, bodyCoverage } = await import('../src/pages');
  const { savePage } = await import('../src/cache');

  await withStub([{ count: 1, pages: [page('a', { title: 'one' })] }], (runner) => {
    const index = fetchIndex(PROJECT, { runner });
    const entry = index.pages[0];

    // What an older build wrote: the token matches, but nothing ever looked
    // for URLs. Trusting it would answer "no Gyazo images" from a record that
    // could not have known.
    savePage(PROJECT, {
      id: entry.id,
      title: entry.title,
      updated: entry.updated,
      links: [],
      cachedAt: new Date().toISOString(),
    } as any);

    expect(bodyCoverage(PROJECT, index)).toEqual({ known: 0, total: 1 });
    expect(collectUrls(PROJECT, index)).toEqual([]);
  });
});
