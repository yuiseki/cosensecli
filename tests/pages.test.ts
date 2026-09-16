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

function page(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `page-${id}`,
    updated: 1000,
    created: 500,
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
