/**
 * The default project.
 *
 * The `cosense` CLI has no notion of a current project: every command takes a
 * project or page URL, which is right for a command line. Over MCP it is not,
 * because the person asking is speaking rather than typing, and naming the
 * project in every sentence is the sort of thing they asked an assistant to
 * stop doing. So this package adds one, and only here.
 *
 * It is a default and not a binding: every tool still takes a project URL, and
 * a given one wins. Other projects stay reachable through the same connector.
 */

export const DEFAULT_PROJECT_ENV = 'COSENSECLI_DEFAULT_PROJECT';

/**
 * Turns a project URL into its canonical `origin/name` form.
 *
 * Accepts what a person would paste: with or without a trailing slash, and
 * with or without the scheme, because `scrapbox.io/yuiseki` is what the
 * address bar shows. Anything carrying a deeper path is a page URL and is
 * refused, since defaulting to a page would silently answer about one page.
 */
export function normalizeProjectUrl(input: string, source: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error(`${source} is empty. Set it to a project URL, e.g. https://scrapbox.io/yuiseki`);
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${source} is not a valid URL: ${input}`);
  }
  if (url.search || url.hash) {
    throw new Error(`${source} must not carry a query or a fragment: ${input}`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(
      `${source} must name a project, as https://<host>/<project>: ${input}`,
    );
  }
  if (segments.length > 1) {
    throw new Error(
      `${source} must be a project URL, not a page URL. ` +
        `Use https://${url.host}/${segments[0]} rather than ${input}`,
    );
  }
  return `${url.origin}/${segments[0]}`;
}

/** The configured default project, or undefined when there is none. */
export function defaultProjectUrl(): string | undefined {
  const raw = process.env[DEFAULT_PROJECT_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  return normalizeProjectUrl(raw, DEFAULT_PROJECT_ENV);
}

/**
 * The project a call is about: the one it named, else the default.
 *
 * The error names the environment variable, because a client that reached this
 * point asked a question with no project in it and cannot fix that itself.
 */
export function resolveProjectUrl(given?: string): string {
  if (given !== undefined && given.trim() !== '') {
    return normalizeProjectUrl(given, 'project_url');
  }
  const fallback = defaultProjectUrl();
  if (fallback === undefined) {
    throw new Error(
      'No project was given and no default is configured. Pass project_url, ' +
        `or set ${DEFAULT_PROJECT_ENV} to a project URL such as ` +
        'https://scrapbox.io/yuiseki.',
    );
  }
  return fallback;
}

/**
 * The Cosense convention for putting a title in a URL.
 *
 * Copied from `encodeTitleForUrl` in @helpfeel/cosense-cli
 * (src/lib/encodeTitle.ts), which cannot be imported: that package ships ES
 * modules with .ts specifiers and runs through tsx, while this one is
 * CommonJS. Unicode stays raw, a space becomes `_`, and the four characters
 * that would otherwise break the route or the URL syntax are percent-encoded.
 */
export function encodeTitleForUrl(title: string): string {
  return title
    .replace(/%/g, '%25')
    .replace(/\//g, '%2F')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23')
    .replace(/ /g, '_');
}

/**
 * The page a call is about, from either a whole URL or a title.
 *
 * A title is the useful form once there is a default project: search and the
 * related page lists answer in titles, so following one should not require the
 * client to rebuild a URL and get the encoding right.
 */
export function resolvePageUrl(params: {
  pageUrl?: string;
  title?: string;
  projectUrl?: string;
}): string {
  const { pageUrl, title, projectUrl } = params;
  const hasPageUrl = pageUrl !== undefined && pageUrl.trim() !== '';
  const hasTitle = title !== undefined && title.trim() !== '';

  if (hasPageUrl && hasTitle) {
    throw new Error('Pass either page_url or title, not both.');
  }
  if (hasPageUrl) {
    return pageUrl!.trim();
  }
  if (!hasTitle) {
    throw new Error('Pass page_url, or title together with a default project.');
  }
  return `${resolveProjectUrl(projectUrl)}/${encodeTitleForUrl(title!.trim())}`;
}
