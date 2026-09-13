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
  const { status, stderr } = runCli(ws, ['sync']);

  expect(status).toBe(2);
  expect(stderr).toContain('unknown command: sync');
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
