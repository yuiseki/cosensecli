/**
 * The project index: every page's metadata, and what it lets us answer.
 *
 * The page list endpoint returns up to 1000 pages per request with `updated`,
 * `linked`, `views`, `linesCount` and `charsCount` on each, so a whole project
 * is a handful of requests. That is cheap enough to refresh often, and it is
 * what makes a cached page body checkable: one walk of the list tells us which
 * of the cached pages are still current.
 *
 * It is also the answer to questions the API itself will not sort by. Passing
 * an unknown `sort` to Cosense is not an error; it silently falls back to
 * `updated`, so a ranking by line count asked for that way would come back
 * looking plausible and be wrong. Ranking here, over the index, is the only
 * way to get one that is right.
 */
import {
  INDEX_VERSION,
  loadIndex,
  loadPage,
  savePage,
  saveIndex,
  type CachedPage,
  type IndexEntry,
  type ProjectIndex,
} from './cache';
import { encodeTitleForUrl } from './defaults';
import { runCosense, type CosenseResult } from './cosense';

/**
 * How this module reaches the CLI.
 *
 * A seam rather than a direct call, so the walk can be driven in a test
 * without a process and without patching a module. Production passes nothing
 * and gets the real thing.
 */
export type Runner = (command: string, args?: string[]) => CosenseResult;

/** What the page list endpoint returns per request. */
const PAGE_SIZE = 1000;

/** How many requests a single walk may make, so one call cannot run away. */
const DEFAULT_MAX_REQUESTS = 10;

/** How old an index may be before a read refreshes it, in seconds. */
export const DEFAULT_MAX_AGE_SECONDS = 900;

type RawPage = {
  id?: unknown;
  title?: unknown;
  updated?: unknown;
  created?: unknown;
  linked?: unknown;
  views?: unknown;
  linesCount?: unknown;
  charsCount?: unknown;
  pin?: unknown;
};

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A timestamp as the CLI reports it, kept whole and also parsed.
 *
 * The CLI rewrites created/updated/accessed into a human form before printing:
 * "2025-03-12T19:13+09:00 (2 years ago)". An earlier version of this file ran
 * that through Number() and stored 0 for every page, which is the failure this
 * shape exists to prevent. The token is what validation compares; the parsed
 * value is only for ordering, and is null rather than 0 when the parse fails,
 * so a missing timestamp cannot pass for an old one.
 *
 * A raw unix-seconds number is still accepted, in case the CLI stops
 * enriching, or another caller hands us the API's own shape.
 */
function toTimestamp(value: unknown): { token: string; epochMs: number | null } {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { token: String(value), epochMs: value * 1000 };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return { token: '', epochMs: null };
  }
  const token = value.trim();
  // The absolute part runs up to the space before the parenthesised relative
  // form, and is what Date can read.
  const absolute = token.split(' ')[0] as string;
  const parsed = Date.parse(absolute);
  return { token, epochMs: Number.isFinite(parsed) ? parsed : null };
}

function toEntry(raw: RawPage): IndexEntry | null {
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  const updated = toTimestamp(raw.updated);
  const created = toTimestamp(raw.created);
  return {
    id: raw.id,
    title: raw.title,
    updated: updated.token,
    updatedAt: updated.epochMs,
    created: created.token,
    createdAt: created.epochMs,
    linked: toNumber(raw.linked),
    views: toNumber(raw.views),
    linesCount: toNumber(raw.linesCount),
    charsCount: toNumber(raw.charsCount),
    pin: toNumber(raw.pin),
  };
}

/**
 * Walks the page list until the project runs out or the request budget does.
 *
 * `--sort title` is asked for deliberately. The default order is by update
 * time, which moves while the walk is running: a page edited between request
 * two and three shifts to the front and pushes an unseen page across the
 * boundary, so the walk would miss it. Title order does not change under an
 * edit.
 */
export function fetchIndex(
  projectUrl: string,
  options: { maxRequests?: number; runner?: Runner } = {},
): ProjectIndex {
  const run = options.runner ?? runCosense;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const pages: IndexEntry[] = [];
  const seen = new Set<string>();
  let count = 0;
  let truncated = false;

  for (let request = 0; request < maxRequests; request += 1) {
    const skip = request * PAGE_SIZE;
    const { stdout } = run('listPages', [
      projectUrl,
      '--sort',
      'title',
      '--limit',
      String(PAGE_SIZE),
      '--skip',
      String(skip),
    ]);

    let payload: { count?: unknown; pages?: unknown };
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error(
        `listPages did not return JSON for ${projectUrl}. Got: ${stdout.slice(0, 200)}`,
      );
    }

    count = toNumber(payload.count);
    const batch = Array.isArray(payload.pages) ? (payload.pages as RawPage[]) : [];
    for (const raw of batch) {
      const entry = toEntry(raw);
      // A page can appear twice across requests if the project changed under
      // the walk. Keeping the first is enough; the next refresh corrects it.
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        pages.push(entry);
      }
    }

    if (batch.length < PAGE_SIZE) break;
    if (request === maxRequests - 1 && pages.length < count) truncated = true;
  }

  return {
    version: INDEX_VERSION,
    project: projectUrl,
    fetchedAt: new Date().toISOString(),
    count,
    truncated,
    pages,
  };
}

export function indexAgeSeconds(index: ProjectIndex, now: Date = new Date()): number {
  const fetched = Date.parse(index.fetchedAt);
  if (!Number.isFinite(fetched)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - fetched) / 1000);
}

export type IndexResult = {
  index: ProjectIndex;
  /** Whether this call went to the network. */
  refreshed: boolean;
  ageSeconds: number;
};

/**
 * The index for a project, from the cache when it is recent enough.
 *
 * Writing on the way through is deliberate, and is how gyazocli fills its
 * cache: there is no separate sync to remember to run, so the first question
 * asked about a project is what makes the second one fast.
 */
export function getIndex(
  projectUrl: string,
  options: {
    maxAgeSeconds?: number;
    refresh?: boolean;
    maxRequests?: number;
    runner?: Runner;
  } = {},
): IndexResult {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const cached = options.refresh ? null : loadIndex(projectUrl);

  if (cached && indexAgeSeconds(cached) <= maxAge) {
    return { index: cached, refreshed: false, ageSeconds: indexAgeSeconds(cached) };
  }

  const fresh = fetchIndex(projectUrl, {
    maxRequests: options.maxRequests,
    runner: options.runner,
  });
  saveIndex(projectUrl, fresh);
  return { index: fresh, refreshed: true, ageSeconds: 0 };
}

export type RankKey =
  | 'lines'
  | 'chars'
  | 'linked'
  | 'views'
  | 'updated'
  | 'created'
  | 'title';

const RANK_VALUE: Record<RankKey, (entry: IndexEntry) => number | string | null> = {
  lines: (entry) => entry.linesCount,
  chars: (entry) => entry.charsCount,
  linked: (entry) => entry.linked,
  views: (entry) => entry.views,
  updated: (entry) => entry.updatedAt,
  created: (entry) => entry.createdAt,
  title: (entry) => entry.title,
};

/**
 * How many entries carry a usable value for a key.
 *
 * A ranking by a key nothing has is not an empty ranking, it is a broken one,
 * and the caller has to be able to tell the difference.
 */
export function rankableCount(index: ProjectIndex, by: RankKey): number {
  const value = RANK_VALUE[by];
  return index.pages.filter((entry) => value(entry) !== null).length;
}

/**
 * Orders the whole index by one key.
 *
 * Pinned pages are not floated to the front. The API does that for its own
 * sorts, which is why a small `limit` there shows the same pages whatever the
 * sort is; a ranking that quietly did the same would not be a ranking.
 */
export function rankPages(
  index: ProjectIndex,
  by: RankKey,
  options: { order?: 'desc' | 'asc'; limit?: number } = {},
): IndexEntry[] {
  const order = options.order ?? (by === 'title' ? 'asc' : 'desc');
  const direction = order === 'asc' ? 1 : -1;
  const value = RANK_VALUE[by];

  // A page with no usable value is not ranked at all. Sorting it as zero
  // would put it at one end of the list as though that were its measurement.
  const sorted = index.pages
    .filter((entry) => value(entry) !== null)
    .sort((left, right) => {
      const a = value(left) as number | string;
      const b = value(right) as number | string;
      if (typeof a === 'string' || typeof b === 'string') {
        return String(a).localeCompare(String(b), 'ja') * direction;
      }
      if (a === b) return left.title.localeCompare(right.title, 'ja');
      return (a < b ? -1 : 1) * direction;
    });

  const limit = options.limit ?? 20;
  return sorted.slice(0, limit);
}

/**
 * Outgoing links, which the page list does not carry.
 *
 * `linked` in the index is the inverse relation: how many pages point here.
 * How many a page points at lives in its body, so counting them means reading
 * every page, one request each. A whole project is thousands of requests and
 * many minutes, which is why this is budgeted rather than done in one go: a
 * call takes a bite, records what it learned, and the next one starts from
 * there. gyazocli fills its cache the same way, by being asked questions.
 */
/**
 * Pages fetched per call when nobody says otherwise.
 *
 * Measured at about 0.84s each: a third of that is the request, the rest is
 * starting a `cosense` process, since there is one per page. Twenty keeps a
 * tool call near fifteen seconds, which a connector will wait for. Reading a
 * whole project this way takes roughly three quarters of an hour, so that is
 * what `cosensecli crawl` is for rather than a tool call with a large budget.
 */
export const DEFAULT_CRAWL_BUDGET = 20;

/**
 * A pause between requests, in milliseconds.
 *
 * Thousands of reads of somebody else's server deserve some spacing, the way
 * hatebucli spaces its feed requests.
 */
export const DEFAULT_CRAWL_DELAY_MS = 50;

/** Blocks for a while. The CLI is driven synchronously, so this has to be too. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export type CrawlReport = {
  /** Pages read from the network this call. */
  fetched: number;
  /** Pages whose cached copy was still current. */
  current: number;
  /** Pages still needing a read after this call. */
  remaining: number;
  /** Pages that failed to read, which stay remaining rather than counting. */
  failed: number;
};

function isCurrent(cached: CachedPage | null, entry: IndexEntry): boolean {
  // Equality on the token, not a comparison: the token is opaque, and the
  // only question is whether the page has moved since it was cached.
  return cached !== null && cached.updated !== '' && cached.updated === entry.updated;
}

/**
 * Reads page bodies until the budget runs out, keeping only the links.
 *
 * The body itself is deliberately not kept. What a page renders as depends on
 * other pages too, since the related-page list moves when something else links
 * here, so a cached rendering could not be validated by this page's `updated`
 * alone. Outgoing links can: they are a property of this page's body and
 * nothing else.
 */
export function crawlLinks(
  projectUrl: string,
  index: ProjectIndex,
  options: {
    budget?: number;
    delayMs?: number;
    runner?: Runner;
    onProgress?: (done: number, total: number) => void;
  } = {},
): CrawlReport {
  const run = options.runner ?? runCosense;
  const budget = options.budget ?? DEFAULT_CRAWL_BUDGET;
  const delayMs = options.delayMs ?? DEFAULT_CRAWL_DELAY_MS;

  let fetched = 0;
  let current = 0;
  let failed = 0;
  const stale: IndexEntry[] = [];

  for (const entry of index.pages) {
    if (isCurrent(loadPage(projectUrl, entry.id), entry)) current += 1;
    else stale.push(entry);
  }

  for (const entry of stale) {
    if (fetched >= budget) break;
    const url = `${projectUrl}/${encodeTitleForUrl(entry.title)}`;
    try {
      if (fetched > 0) sleepSync(delayMs);
      const { stdout } = run('readPage', [url]);
      const page = JSON.parse(stdout) as { links?: unknown };
      const links = Array.isArray(page.links) ? page.links.map(String) : [];
      savePage(projectUrl, {
        id: entry.id,
        title: entry.title,
        updated: entry.updated,
        links,
        cachedAt: new Date().toISOString(),
      });
      fetched += 1;
      options.onProgress?.(fetched, Math.min(budget, stale.length));
    } catch {
      // One unreadable page must not end the crawl. It stays stale, so the
      // next call tries it again rather than recording a wrong answer.
      failed += 1;
      fetched += 1;
    }
  }

  return {
    fetched,
    current,
    remaining: Math.max(0, stale.length - fetched),
    failed,
  };
}

export type LinkCount = { entry: IndexEntry; links: number };

/** Outgoing link counts for the pages whose cached body is still current. */
export function knownLinkCounts(
  projectUrl: string,
  index: ProjectIndex,
): LinkCount[] {
  const counts: LinkCount[] = [];
  for (const entry of index.pages) {
    const cached = loadPage(projectUrl, entry.id);
    if (isCurrent(cached, entry)) {
      counts.push({ entry, links: cached!.links.length });
    }
  }
  return counts;
}
