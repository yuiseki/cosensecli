/**
 * What this package can do, once, for both of its front ends.
 *
 * The MCP server and the command line are two ways in, not two
 * implementations. Each function here takes already-typed arguments, returns
 * the text of an answer, and throws on a problem; the server wraps that in a
 * tool result and the CLI prints it.
 *
 * The thing worth not duplicating was never the entry point. It is the
 * knowledge of which `cosense` command answers a question and how its
 * arguments go together, and that lives here, in one place, testable without
 * either front end.
 */
import { runCosense } from './cosense';
import {
  DEFAULT_ORIGIN,
  defaultProjectUrl,
  encodeTitleForUrl,
  resolvePageUrl,
  resolveProjectUrl,
} from './defaults';
import {
  crawlLinks,
  getIndex,
  knownLinkCounts,
  rankPages,
  rankableCount,
  type RankKey,
} from './pages';

/** Appends `flag value` only when the value was given. */
function optional(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(flag, String(value));
}

/**
 * Runs a command and returns what it printed.
 *
 * An empty answer is reported as such rather than as an empty string, which
 * at the other end is indistinguishable from a tool that did nothing.
 */
function run(command: string, args: string[]): string {
  const { stdout } = runCosense(command, args);
  return stdout.trim() === '' ? '(the command returned nothing)' : stdout;
}

/** The Cosense host to ask about when none was named. */
export function defaultOrigin(): string {
  const project = defaultProjectUrl();
  return project === undefined ? DEFAULT_ORIGIN : new URL(project).origin;
}

export type PageTarget = {
  pageUrl?: string;
  title?: string;
  projectUrl?: string;
};

export function browsePage(target: PageTarget): string {
  return run('browsePage', [resolvePageUrl({ ...target })]);
}

export function browseRelatedPages(target: PageTarget): string {
  return run('browseRelatedPages', [resolvePageUrl({ ...target })]);
}

export function search(params: {
  projectUrl?: string;
  query: string;
  or?: boolean;
  sort?: 'pageRank' | 'updated';
}): string {
  const args = [resolveProjectUrl(params.projectUrl), params.query];
  if (params.or) args.push('--or');
  optional(args, '--sort', params.sort);
  return run('searchFullText', args);
}

export function searchVector(params: { projectUrl?: string; query: string }): string {
  return run('searchVector', [resolveProjectUrl(params.projectUrl), params.query]);
}

export function listPages(params: {
  projectUrl?: string;
  sort?: string;
  limit?: number;
  skip?: number;
}): string {
  const args = [resolveProjectUrl(params.projectUrl)];
  optional(args, '--sort', params.sort);
  optional(args, '--limit', params.limit);
  optional(args, '--skip', params.skip);
  return run('listPages', args);
}

export function pageChanges(params: {
  projectUrl?: string;
  pageId: string;
  since?: string;
}): string {
  const args = [resolveProjectUrl(params.projectUrl), params.pageId];
  optional(args, '--since', params.since);
  return run('browsePageChanges', args);
}

export function readFileInfo(params: { fileUrl: string; projectUrl?: string }): string {
  const args = [params.fileUrl];
  // The default project applies here too: a file URL carries no project, and
  // a private one needs to be told which project may read it.
  optional(args, '--project', params.projectUrl ?? defaultProjectUrl());
  return run('readFileInfo', args);
}

export function listProjects(params: { origin?: string } = {}): string {
  return run('listProjects', [params.origin ?? defaultOrigin()]);
}

export type RankParams = {
  projectUrl?: string;
  by: RankKey | 'links';
  order?: 'desc' | 'asc';
  limit?: number;
  refresh?: boolean;
  /** Only for `links`: how many page bodies to read this call. */
  budget?: number;
};

export function rank(params: RankParams): string {
  const project = resolveProjectUrl(params.projectUrl);
  const { index, refreshed, ageSeconds } = getIndex(project, { refresh: params.refresh });

  if (params.by === 'links') {
    return rankByOutgoingLinks(project, index, {
      order: params.order,
      limit: params.limit,
      budget: params.budget,
      refreshed,
      ageSeconds,
    });
  }

  const key = params.by as RankKey;
  const measurable = rankableCount(index, key);

  // A key nothing carries is a broken ranking, not an empty one, and
  // returning no rows would read as "the project has no such pages".
  if (measurable === 0) {
    throw new Error(
      `No page in ${project} carries a usable ${params.by} value, so it cannot ` +
        'be ranked by that. Try refresh, or rank by lines, chars, linked or ' +
        'views, which come straight from the page list.',
    );
  }

  const rows = rankPages(index, key, { order: params.order, limit: params.limit });
  const header = [
    `project: ${project}`,
    `pages in project: ${index.count}`,
    `pages in index: ${index.pages.length}${index.truncated ? ' (partial: the walk hit its request budget)' : ''}`,
    `ranked by: ${params.by} ${params.order ?? (params.by === 'title' ? 'asc' : 'desc')}`,
    `measurable by ${params.by}: ${measurable}${measurable < index.pages.length ? ` of ${index.pages.length}` : ''}`,
    `index: ${refreshed ? 'just walked' : `${Math.round(ageSeconds)}s old`}`,
    '',
  ];
  const body = rows.map((entry, position) => {
    const url = `${project}/${encodeTitleForUrl(entry.title)}`;
    return (
      `${position + 1}. ${entry.title}\n` +
      `   lines ${entry.linesCount} / chars ${entry.charsCount} / ` +
      `linked ${entry.linked} / views ${entry.views}\n` +
      `   ${url}`
    );
  });
  return `${header.join('\n')}${body.join('\n')}`;
}

/**
 * Ranking by outgoing links, which needs every page body read.
 *
 * Reports coverage rather than pretending to a whole-project answer: a top ten
 * drawn from a fifth of the project is a real answer about that fifth, and a
 * misleading one about the project, so the difference is stated rather than
 * left for the reader to assume.
 */
function rankByOutgoingLinks(
  project: string,
  index: ReturnType<typeof getIndex>['index'],
  options: {
    order?: 'desc' | 'asc';
    limit?: number;
    budget?: number;
    refreshed: boolean;
    ageSeconds: number;
  },
): string {
  const report = crawlLinks(project, index, { budget: options.budget });
  const counts = knownLinkCounts(project, index);

  if (counts.length === 0) {
    throw new Error(
      `No page body of ${project} has been read yet, so outgoing links cannot ` +
        'be ranked. This reads the project a bite at a time; call again to ' +
        `continue (${report.failed > 0 ? `${report.failed} failed to read, ` : ''}` +
        `${report.remaining} pages still to read).`,
    );
  }

  const direction = (options.order ?? 'desc') === 'asc' ? 1 : -1;
  const rows = [...counts]
    .sort((left, right) => {
      if (left.links === right.links) {
        return left.entry.title.localeCompare(right.entry.title, 'ja');
      }
      return (left.links < right.links ? -1 : 1) * direction;
    })
    .slice(0, options.limit ?? 20);

  const coverage = ((counts.length / index.pages.length) * 100).toFixed(1);
  const header = [
    `project: ${project}`,
    `pages in project: ${index.count}`,
    `pages in index: ${index.pages.length}`,
    `ranked by: links ${options.order ?? 'desc'}`,
    `bodies read: ${counts.length} of ${index.pages.length} (${coverage}%)` +
      `${report.remaining > 0 ? `, ${report.remaining} to go` : ', complete'}`,
    `this call read: ${report.fetched}${report.failed > 0 ? ` (${report.failed} failed)` : ''}`,
    `index: ${options.refreshed ? 'just walked' : `${Math.round(options.ageSeconds)}s old`}`,
    '',
  ];
  if (report.remaining > 0) {
    header.splice(
      5,
      0,
      'note: this ranking covers the pages read so far, not the whole project.',
    );
  }

  const body = rows.map((row, position) => {
    const url = `${project}/${encodeTitleForUrl(row.entry.title)}`;
    return (
      `${position + 1}. ${row.entry.title}\n` +
      `   links out ${row.links} / linked in ${row.entry.linked} / ` +
      `lines ${row.entry.linesCount}\n` +
      `   ${url}`
    );
  });

  return `${header.join('\n')}${body.join('\n')}`;
}
