/**
 * The local cache.
 *
 * Modelled on gyazocli's, which is greedy: it writes on every read path rather
 * than only from a sync command, and it never expires anything. That works
 * there because a Gyazo capture is immutable, so a cached copy cannot become
 * wrong.
 *
 * A Cosense page is not immutable, so the same greed needs something gyazocli
 * has no use for: a way to tell a cached copy from a current one. That is what
 * `updated` is for. The page list returns it for up to 1000 pages in one
 * request, so the whole project can be checked in a handful of calls, and any
 * cached page whose `updated` still matches is known good rather than assumed
 * good.
 *
 * Reading never creates a directory. Only the write paths ask for that, so a
 * sandbox with a read-only home can still read the cache it has, the way
 * hatebucli had to be taught.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One page, as the page list reports it.
 *
 * `updated` is kept as the string the CLI printed rather than a number, and is
 * compared for equality rather than ordering. The CLI formats timestamps for a
 * reader ("2025-03-12T19:13+09:00 (2 years ago)"), so parsing one into a number
 * is a second thing that can go wrong; treating it as an opaque token is both
 * simpler and what validation actually needs, the way an ETag is used.
 *
 * `updatedAt` is that token parsed to epoch milliseconds, for ordering only,
 * and is null when it could not be parsed. Null rather than 0: a page with no
 * known timestamp must be distinguishable from one modified in 1970, because
 * the first is a fault here and the second is data.
 */
export type IndexEntry = {
  id: string;
  title: string;
  updated: string;
  updatedAt: number | null;
  created: string;
  createdAt: number | null;
  linked: number;
  views: number;
  linesCount: number;
  charsCount: number;
  pin: number;
};

/**
 * Bumped when the shape of an entry changes, so an index written by an older
 * build is discarded rather than read as though it meant the same thing. The
 * first version stored `updated` as a number, which was always 0, because the
 * CLI hands back a formatted string.
 */
export const INDEX_VERSION = 2;

export type ProjectIndex = {
  version: number;
  project: string;
  /** ISO 8601, when the walk that produced this finished. */
  fetchedAt: string;
  /** What the server said the project holds, which may exceed `pages.length`. */
  count: number;
  /** Whether the walk stopped early, so a ranking knows it is partial. */
  truncated: boolean;
  pages: IndexEntry[];
};

export function getCacheDir(options: { create?: boolean } = {}): string {
  const override = process.env.COSENSECLI_CACHE_DIR;
  const dir =
    override && override.trim() !== ''
      ? override.trim()
      : path.join(
          process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
          'cosensecli',
        );
  if (options.create && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * The directory a project's cache lives in, as `<host>/<project>`.
 *
 * The host is part of the key because the same project name on a self-hosted
 * instance is a different project, and mixing them would answer one with the
 * other's pages.
 */
export function projectCacheDir(
  projectUrl: string,
  options: { create?: boolean } = {},
): string {
  const url = new URL(projectUrl);
  const name = url.pathname.split('/').filter(Boolean)[0] ?? '_';
  const dir = path.join(getCacheDir(options), 'projects', url.host, name);
  if (options.create && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function indexPath(projectUrl: string, options: { create?: boolean } = {}): string {
  return path.join(projectCacheDir(projectUrl, options), 'index.json');
}

export function loadIndex(projectUrl: string): ProjectIndex | null {
  const file = indexPath(projectUrl);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectIndex;
    // An index from an older build says nothing about what its fields mean.
    if (parsed?.version !== INDEX_VERSION) return null;
    return parsed;
  } catch {
    // A half-written index should send the caller to the network, not take
    // the call down.
    return null;
  }
}

export function saveIndex(projectUrl: string, index: ProjectIndex): void {
  const file = indexPath(projectUrl, { create: true });
  // Written to a sibling and renamed, so a reader never sees half a file.
  // Two tool calls can be walking the same project at once.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Where one page's cached body goes.
 *
 * Two levels of prefix, as gyazocli does, so no single directory holds tens of
 * thousands of entries.
 */
export function pagePath(
  projectUrl: string,
  pageId: string,
  options: { create?: boolean } = {},
): string {
  const first = pageId[0] || '_';
  const second = pageId[1] || '_';
  const dir = path.join(projectCacheDir(projectUrl, options), 'pages', first, second);
  if (options.create && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${pageId}.json`);
}

/**
 * A cached rendering of one page, with the `updated` it was true at.
 *
 * `text` is what the CLI printed, not a parsed structure: this package passes
 * the CLI's output through, so that is the thing worth keeping.
 */
export type CachedPage = {
  id: string;
  title: string;
  /** The index token this was true at. Compared for equality, never ordered. */
  updated: string;
  /** Outgoing links, which are a property of this page's body alone. */
  links: string[];
  cachedAt: string;
};

export function loadPage(projectUrl: string, pageId: string): CachedPage | null {
  const file = pagePath(projectUrl, pageId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CachedPage;
  } catch {
    return null;
  }
}

export function savePage(projectUrl: string, entry: CachedPage): void {
  const file = pagePath(projectUrl, entry.id, { create: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Replaces rather than merges.
 *
 * gyazocli merges a cached copy into a fresh one, which is right for immutable
 * data and wrong here: a line deleted from a page would come back, because a
 * merge has no way to express a removal.
 */
export function replacePage(projectUrl: string, entry: CachedPage): void {
  savePage(projectUrl, entry);
}
