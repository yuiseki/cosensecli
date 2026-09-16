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
import { loadIndex, saveIndex, type IndexEntry, type ProjectIndex } from './cache';
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

function toEntry(raw: RawPage): IndexEntry | null {
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    updated: toNumber(raw.updated),
    created: toNumber(raw.created),
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

const RANK_VALUE: Record<RankKey, (entry: IndexEntry) => number | string> = {
  lines: (entry) => entry.linesCount,
  chars: (entry) => entry.charsCount,
  linked: (entry) => entry.linked,
  views: (entry) => entry.views,
  updated: (entry) => entry.updated,
  created: (entry) => entry.created,
  title: (entry) => entry.title,
};

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

  const sorted = [...index.pages].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (typeof a === 'string' || typeof b === 'string') {
      return String(a).localeCompare(String(b), 'ja') * direction;
    }
    if (a === b) return left.title.localeCompare(right.title, 'ja');
    return (a < b ? -1 : 1) * direction;
  });

  const limit = options.limit ?? 20;
  return sorted.slice(0, limit);
}
