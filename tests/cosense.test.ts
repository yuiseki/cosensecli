/**
 * The read-only boundary, and the CLI around the server.
 *
 * The allowlist is the whole security argument of this package, so it is
 * tested by name rather than by shape: a command added to the CLI upstream
 * does not become reachable here until someone puts it in the list.
 */
import { expect, test } from 'vitest';
import { createTempWorkspace, runCli, stubCalls } from './helpers';
import { isReadOnlyCommand, READ_ONLY_COMMANDS } from '../src/cosense';

const WRITE_COMMANDS = [
  'login',
  'previewEdit',
  'previewDelete',
  'submitEdit',
  'replaceLinks',
  'uploadFile',
  'deleteFile',
  'downloadFile',
];

test('no command that writes is on the allowlist', () => {
  for (const command of WRITE_COMMANDS) {
    expect(isReadOnlyCommand(command)).toBe(false);
  }
});

test('the allowlist holds exactly the read-only commands of the CLI', () => {
  expect([...READ_ONLY_COMMANDS].sort()).toEqual([
    'browsePage',
    'browsePageChanges',
    'browseRelatedPages',
    'list1hopLinks',
    'list2hopLinks',
    'listPageSnapshots',
    'listPages',
    'listProjects',
    'readFileInfo',
    'readPage',
    'readPageSnapshot',
    'readProjectMembers',
    'search1hopLinks',
    'search2hopLinks',
    'searchFullText',
    'searchVector',
    'whoami',
  ]);
});

test('an unknown command is refused before a process is started', async () => {
  const { runCosense } = await import('../src/cosense');
  expect(() => runCosense('submitEdit', ['x'])).toThrow(/not a read-only cosense command/);
});

test('--help says what the server will not do', () => {
  const ws = createTempWorkspace();
  const { stdout, status } = runCli(ws, ['--help']);

  expect(status).toBe(0);
  expect(stdout).toContain('Nothing here writes to Cosense');
  expect(stdout).toContain('submitEdit');
});

test('--version prints the package version', () => {
  const ws = createTempWorkspace();
  const { stdout } = runCli(ws, ['--version']);

  expect(stdout.trim()).toBe(`cosensecli v${require('../package.json').version}`);
});

test('doctor reports the binary it found, and treats a 401 as a working setup', () => {
  const ws = createTempWorkspace();
  const { stdout, status } = runCli(ws, ['doctor'], {
    replies: { whoami: 'EXIT:1:HTTP 401 Unauthorized' },
  });

  expect(status).toBe(0);
  expect(stdout).toContain(ws.stubPath);
  expect(stdout).toContain('authenticated:  no');
  expect(stubCalls(ws)).toEqual([['whoami', 'https://scrapbox.io']]);
});

test('doctor fails when the CLI cannot run at all', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['doctor'], {
    env: { COSENSECLI_COSENSE_BIN: '/nonexistent/cosense' },
  });

  expect(status).toBe(1);
  expect(stderr).toContain('/nonexistent/cosense');
});

test('an unknown cosensecli command exits 2', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['fetch']);

  expect(status).toBe(2);
  expect(stderr).toContain('unknown command: fetch');
});

test('doctor treats a locally missing token as unauthenticated, not broken', () => {
  const ws = createTempWorkspace();
  // The message the CLI actually prints when nothing is stored. It never
  // reaches the server, so there is no HTTP status to match on.
  const { stdout, status } = runCli(ws, ['doctor'], {
    replies: {
      whoami:
        'EXIT:1:No Personal Access Token found for https://scrapbox.io. Run `cosense login https://scrapbox.io` to authenticate.',
    },
  });

  expect(status).toBe(0);
  expect(stdout).toContain('authenticated:  no');
});

test('doctor reports the default project it will use', () => {
  const ws = createTempWorkspace();
  const { stdout } = runCli(ws, ['doctor'], {
    replies: { whoami: 'name: yuiseki' },
    env: { COSENSECLI_DEFAULT_PROJECT: 'scrapbox.io/yuiseki' },
  });

  expect(stdout).toContain('default project: https://scrapbox.io/yuiseki');
  expect(stdout).toContain('authenticated:  yes');
});

test('doctor refuses a default project that is a page URL', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['doctor'], {
    env: { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki/地図' },
  });

  expect(status).toBe(1);
  expect(stderr).toContain('must be a project URL, not a page URL');
});

test('a fresh process per call is what lets credentials appear without a restart', () => {
  const ws = createTempWorkspace();

  // Two calls, two spawns. The claim in the startup message rests on this:
  // nothing is carried between calls, so a settings file written after the
  // server started is read by the next child.
  runCli(ws, ['doctor'], { replies: { whoami: 'name: a' } });
  runCli(ws, ['doctor'], { replies: { whoami: 'name: b' } });

  expect(stubCalls(ws)).toEqual([
    ['whoami', 'https://scrapbox.io'],
    ['whoami', 'https://scrapbox.io'],
  ]);
});

test('sync refuses a budget that is not a positive number', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['sync', '--budget', 'lots'], {
    env: { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki' },
  });

  expect(status).toBe(2);
  expect(stderr).toContain('--budget needs a positive number');
});

test('sync says which project it is about, and needs one', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['sync']);

  expect(status).toBe(1);
  expect(stderr).toContain('COSENSECLI_DEFAULT_PROJECT');
});

test('sync reads bodies and reports what it did', () => {
  const ws = createTempWorkspace();
  const listing = {
    count: 2,
    pages: [
      { id: 'a', title: 'one', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
      { id: 'b', title: 'two', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
    ],
  };

  const { stdout, status } = runCli(ws, ['sync', '--budget', '1'], {
    env: {
      COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki',
      COSENSECLI_CACHE_DIR: `${ws.rootDir}/cache`,
    },
    replies: {
      listPages: JSON.stringify(listing),
      readPage: JSON.stringify({ links: ['x'] }),
    },
  });

  expect(status).toBe(0);
  expect(stdout).toContain('index: 2 pages');
  expect(stdout).toContain('read 1 in');
  expect(stdout).toContain('1 to go');
});

test('list-gyazo prints one URL per line and puts coverage on stderr', () => {
  const ws = createTempWorkspace();
  const listing = {
    count: 2,
    pages: [
      { id: 'a', title: 'one', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
      { id: 'b', title: 'two', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
    ],
  };
  const env = {
    COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki',
    COSENSECLI_CACHE_DIR: `${ws.rootDir}/cache`,
  };
  const replies = {
    listPages: JSON.stringify(listing),
    readPage: JSON.stringify({
      links: [],
      lines: [{ text: 'https://gyazo.com/aaa and https://example.com/b' }],
    }),
  };

  runCli(ws, ['sync'], { env, replies });
  const { stdout, stderr, status } = runCli(ws, ['list-gyazo'], { env, replies });

  expect(status).toBe(0);
  // stdout is URLs only, so the command pipes into something else.
  expect(stdout).toBe('https://gyazo.com/aaa\n');
  expect(stderr).toContain('2 found on 2 pages');
  expect(stderr).not.toContain('warning');
});

test('list-gyazo warns when the crawl is incomplete', () => {
  const ws = createTempWorkspace();
  const listing = {
    count: 2,
    pages: [
      { id: 'a', title: 'one', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
      { id: 'b', title: 'two', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
    ],
  };
  const env = {
    COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki',
    COSENSECLI_CACHE_DIR: `${ws.rootDir}/cache`,
  };
  const replies = {
    listPages: JSON.stringify(listing),
    readPage: JSON.stringify({ links: [], lines: [{ text: 'https://gyazo.com/aaa' }] }),
  };

  runCli(ws, ['sync', '--budget', '1'], { env, replies });
  const { stderr } = runCli(ws, ['list-gyazo'], { env, replies });

  // Half the project read, so the list is half an answer and says so.
  expect(stderr).toContain('1 of 2 page bodies have been read');
  expect(stderr).toContain('not the whole project');
});

test('list-urls --with-page keeps the page each URL came from', () => {
  const ws = createTempWorkspace();
  const listing = {
    count: 1,
    pages: [
      { id: 'a', title: '地図の話', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
    ],
  };
  const env = {
    COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki',
    COSENSECLI_CACHE_DIR: `${ws.rootDir}/cache`,
  };
  const replies = {
    listPages: JSON.stringify(listing),
    readPage: JSON.stringify({ links: [], lines: [{ text: 'https://gyazo.com/aaa' }] }),
  };

  runCli(ws, ['sync'], { env, replies });
  const { stdout } = runCli(ws, ['list-urls', '--with-page'], { env, replies });

  expect(stdout).toBe('https://gyazo.com/aaa\t地図の話\n');
});

test('config set stores the default project, accepting a bare name', () => {
  const ws = createTempWorkspace();
  const { stdout, stderr, status } = runCli(ws, [
    'config',
    'set',
    'default-project',
    'yuiseki',
  ]);

  expect(status).toBe(0);
  expect(stdout).toBe('default-project: https://scrapbox.io/yuiseki\n');
  expect(stderr).toContain('projects.json');

  const stored = JSON.parse(
    require('node:fs').readFileSync(
      `${ws.homeDir}/.config/cosensecli/projects.json`,
      'utf8',
    ),
  );
  // Normalised on the way in, so a later read cannot fail on it.
  expect(stored.default).toBe('https://scrapbox.io/yuiseki');
});

test('config get prints the value on stdout and its origin on stderr', () => {
  const ws = createTempWorkspace();
  runCli(ws, ['config', 'set', 'default-project', 'yuiseki']);

  const { stdout, stderr, status } = runCli(ws, ['config', 'get', 'default-project']);

  expect(status).toBe(0);
  // stdout is the value alone, so it can be captured in a shell variable.
  expect(stdout).toBe('https://scrapbox.io/yuiseki\n');
  expect(stderr).toContain('from ');
  expect(stderr).toContain('projects.json');
});

test('the stored default is used when no project is named', () => {
  const ws = createTempWorkspace();
  runCli(ws, ['config', 'set', 'default-project', 'yuiseki']);

  const { stdout } = runCli(ws, ['doctor'], { replies: { whoami: 'name: yuiseki' } });

  expect(stdout).toContain('default project: https://scrapbox.io/yuiseki');
  expect(stdout).toContain('from the config file');
});

test('the environment overrides the stored file, and config set says so', () => {
  const ws = createTempWorkspace();

  const { stderr } = runCli(ws, ['config', 'set', 'default-project', 'yuiseki'], {
    env: { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/help-jp' },
  });

  // Silence here would leave someone wondering why what they just set is not
  // what is being used.
  expect(stderr).toContain('overrides this file');
  expect(stderr).toContain('https://scrapbox.io/help-jp');

  const { stdout } = runCli(ws, ['config', 'get', 'default-project'], {
    env: { COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/help-jp' },
  });
  expect(stdout).toBe('https://scrapbox.io/help-jp\n');
});

test('config set refuses a page URL, before it reaches the file', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, [
    'config',
    'set',
    'default-project',
    'https://scrapbox.io/yuiseki/地図',
  ]);

  expect(status).toBe(1);
  expect(stderr).toContain('not a page URL');
  expect(require('node:fs').existsSync(`${ws.homeDir}/.config/cosensecli/projects.json`)).toBe(
    false,
  );
});

test('config get with nothing set explains how to set it', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['config', 'get', 'default-project']);

  expect(status).toBe(1);
  expect(stderr).toContain('config set default-project');
});

test('an unknown setting is refused by name', () => {
  const ws = createTempWorkspace();
  const { status, stderr } = runCli(ws, ['config', 'set', 'token', 'secret']);

  expect(status).toBe(2);
  expect(stderr).toContain('unknown setting: token');
});

test('a config file that is there but unreadable is an error, not an empty default', () => {
  const ws = createTempWorkspace();
  const fs = require('node:fs');
  fs.mkdirSync(`${ws.homeDir}/.config/cosensecli`, { recursive: true });
  fs.writeFileSync(`${ws.homeDir}/.config/cosensecli/projects.json`, '{ broken');

  const { status, stderr } = runCli(ws, ['config', 'get', 'default-project']);

  // Reporting "no default configured" would send someone looking at the wrong
  // thing entirely.
  expect(status).toBe(1);
  expect(stderr).toContain('not valid JSON');
});

test('reading the config never creates the directory', () => {
  const ws = createTempWorkspace();
  runCli(ws, ['config', 'get', 'default-project']);

  // The MCP server runs where the home directory is read-only.
  expect(require('node:fs').existsSync(`${ws.homeDir}/.config/cosensecli`)).toBe(false);
});

test('XDG_CONFIG_HOME wins over HOME, which is what the spec says', () => {
  const ws = createTempWorkspace();
  const fs = require('node:fs');
  const xdg = `${ws.rootDir}/xdg`;

  runCli(ws, ['config', 'set', 'default-project', 'yuiseki'], {
    env: { XDG_CONFIG_HOME: xdg },
  });

  // Caught by CI: the runner sets XDG_CONFIG_HOME, so a test that set only
  // HOME wrote to the runner's own config directory and then looked for the
  // file somewhere else.
  expect(fs.existsSync(`${xdg}/cosensecli/projects.json`)).toBe(true);
  expect(fs.existsSync(`${ws.homeDir}/.config/cosensecli/projects.json`)).toBe(false);
});

test('crawl is an alias of sync, and says nothing about being one', () => {
  const ws = createTempWorkspace();
  const listing = {
    count: 1,
    pages: [
      { id: 'a', title: 'one', updated: '2025-01-01T00:00+09:00 (a year ago)', created: '2020-01-01T00:00+09:00 (6 years ago)', linked: 0, views: 0, linesCount: 1, charsCount: 1, pin: 0 },
    ],
  };

  const { stdout, stderr, status } = runCli(ws, ['crawl'], {
    env: {
      COSENSECLI_DEFAULT_PROJECT: 'https://scrapbox.io/yuiseki',
      COSENSECLI_CACHE_DIR: `${ws.rootDir}/cache`,
    },
    replies: {
      listPages: JSON.stringify(listing),
      readPage: JSON.stringify({ links: [], lines: [] }),
    },
  });

  expect(status).toBe(0);
  expect(stdout).toContain('read 1 in');
  // An alias, not a deprecation: nagging on every cron run would be noise for
  // a name that is not going anywhere.
  expect(stderr).not.toContain('sync');
});
