/**
 * The default project, and turning a title into a URL.
 *
 * These are the only pieces of Cosense knowledge this package holds itself, so
 * they are tested directly rather than only through the server.
 */
import { afterEach, expect, test } from 'vitest';
import {
  DEFAULT_PROJECT_ENV,
  defaultProjectUrl,
  encodeTitleForUrl,
  normalizeProjectUrl,
  resolvePageUrl,
  resolveProjectUrl,
} from '../src/defaults';

afterEach(() => {
  delete process.env[DEFAULT_PROJECT_ENV];
});

test('a project URL is normalized to origin and name', () => {
  expect(normalizeProjectUrl('https://scrapbox.io/yuiseki', 'x')).toBe(
    'https://scrapbox.io/yuiseki',
  );
  expect(normalizeProjectUrl('https://scrapbox.io/yuiseki/', 'x')).toBe(
    'https://scrapbox.io/yuiseki',
  );
});

test('the scheme may be left off, because that is what the address bar shows', () => {
  expect(normalizeProjectUrl('scrapbox.io/yuiseki', 'x')).toBe(
    'https://scrapbox.io/yuiseki',
  );
});

test('a page URL is refused as a default, rather than silently defaulting to one page', () => {
  expect(() => normalizeProjectUrl('https://scrapbox.io/yuiseki/地図', 'x')).toThrow(
    /must be a project URL, not a page URL/,
  );
});

test('an origin with no project is refused', () => {
  expect(() => normalizeProjectUrl('https://scrapbox.io', 'x')).toThrow(/must name a project/);
});

test('the default is read from the environment', () => {
  expect(defaultProjectUrl()).toBeUndefined();
  process.env[DEFAULT_PROJECT_ENV] = 'https://scrapbox.io/yuiseki/';
  expect(defaultProjectUrl()).toBe('https://scrapbox.io/yuiseki');
});

test('a given project wins over the default', () => {
  process.env[DEFAULT_PROJECT_ENV] = 'https://scrapbox.io/yuiseki';
  expect(resolveProjectUrl('https://scrapbox.io/help-jp')).toBe('https://scrapbox.io/help-jp');
  expect(resolveProjectUrl()).toBe('https://scrapbox.io/yuiseki');
});

test('with no project and no default, the error says how to set one', () => {
  expect(() => resolveProjectUrl()).toThrow(new RegExp(DEFAULT_PROJECT_ENV));
});

test('a title becomes a URL the way Cosense writes them', () => {
  // Spaces become underscores; Japanese stays raw.
  expect(encodeTitleForUrl('地図 と AI')).toBe('地図_と_AI');
  // The four characters that would break the route or the URL syntax.
  expect(encodeTitleForUrl('a/b')).toBe('a%2Fb');
  expect(encodeTitleForUrl('100%')).toBe('100%25');
  expect(encodeTitleForUrl('what?')).toBe('what%3F');
  expect(encodeTitleForUrl('#tag')).toBe('%23tag');
  // % is escaped first, so an escape is not escaped twice.
  expect(encodeTitleForUrl('%2F')).toBe('%252F');
});

test('a title resolves against the default project', () => {
  process.env[DEFAULT_PROJECT_ENV] = 'https://scrapbox.io/yuiseki';
  expect(resolvePageUrl({ title: '地図 と AI' })).toBe(
    'https://scrapbox.io/yuiseki/地図_と_AI',
  );
});

test('a title can be aimed at another project', () => {
  process.env[DEFAULT_PROJECT_ENV] = 'https://scrapbox.io/yuiseki';
  expect(
    resolvePageUrl({ title: 'Cosense', projectUrl: 'https://scrapbox.io/help-jp' }),
  ).toBe('https://scrapbox.io/help-jp/Cosense');
});

test('a whole page URL is passed through untouched', () => {
  expect(resolvePageUrl({ pageUrl: 'https://scrapbox.io/yuiseki/地図_と_AI' })).toBe(
    'https://scrapbox.io/yuiseki/地図_と_AI',
  );
});

test('giving both a URL and a title is refused rather than guessed', () => {
  expect(() =>
    resolvePageUrl({ pageUrl: 'https://scrapbox.io/a/b', title: 'c' }),
  ).toThrow(/either page_url or title/);
});

test('a title with no default project says so', () => {
  expect(() => resolvePageUrl({ title: '地図' })).toThrow(new RegExp(DEFAULT_PROJECT_ENV));
});

test('a bare project name means scrapbox.io, which is the form worth typing', () => {
  expect(normalizeProjectUrl('yuiseki', 'x')).toBe('https://scrapbox.io/yuiseki');
  expect(normalizeProjectUrl('help-jp', 'x')).toBe('https://scrapbox.io/help-jp');
});

test('a bare hostname is still a missing project, not a project name', () => {
  // The dot is what tells them apart. Without this, `scrapbox.io` would
  // quietly become a project called "scrapbox.io" on some other host.
  expect(() => normalizeProjectUrl('scrapbox.io', 'x')).toThrow(/must name a project/);
  expect(() => normalizeProjectUrl('cosense.example.com', 'x')).toThrow(/must name a project/);
});
