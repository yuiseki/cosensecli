/**
 * Shared scaffolding for the tests.
 *
 * Nothing here reaches Cosense. Every test points COSENSECLI_COSENSE_BIN at a
 * stub that records the argv it was called with and prints a canned answer, so
 * the tests cover what this package actually does: choosing a command, building
 * its arguments, and passing its output back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPO_ROOT = process.cwd();
// The published entry point, not dist/index.js: the wrapper is what users run,
// and it is where the Node version check lives.
export const CLI_PATH = path.join(REPO_ROOT, 'bin', 'cosensecli.js');

export type Workspace = {
  rootDir: string;
  homeDir: string;
  stubPath: string;
  argvLog: string;
};

/**
 * A stand-in for the cosense CLI.
 *
 * It appends its argv to a log file and prints whatever the test asked for,
 * keyed by command name. `EXIT:<code>:<stderr>` makes it fail instead, which is
 * how the HTTP errors of the real CLI are simulated.
 */
const STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.COSENSECLI_TEST_ARGV_LOG, JSON.stringify(argv) + '\\n');
const command = argv[0] || '';
const replies = JSON.parse(process.env.COSENSECLI_TEST_REPLIES || '{}');
const reply = Object.prototype.hasOwnProperty.call(replies, command)
  ? replies[command]
  : 'stub output for ' + command;
if (typeof reply === 'string' && reply.startsWith('EXIT:')) {
  const [, code, ...rest] = reply.split(':');
  process.stderr.write(rest.join(':') + '\\n');
  process.exit(Number(code));
}
process.stdout.write(reply + '\\n');
`;

export function createTempWorkspace(): Workspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosensecli-test-'));
  const homeDir = path.join(rootDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const stubPath = path.join(rootDir, 'cosense-stub.js');
  fs.writeFileSync(stubPath, STUB_SOURCE, { mode: 0o755 });
  const argvLog = path.join(rootDir, 'argv.log');
  fs.writeFileSync(argvLog, '');
  return { rootDir, homeDir, stubPath, argvLog };
}

/** Every argv the stub was called with, in order. */
export function stubCalls(workspace: Workspace): string[][] {
  return fs
    .readFileSync(workspace.argvLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[]);
}

export type RunOptions = {
  replies?: Record<string, string>;
  env?: Record<string, string>;
};

function baseEnv(workspace: Workspace, options: RunOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: workspace.homeDir,
    COSENSECLI_COSENSE_BIN: workspace.stubPath,
    COSENSECLI_TEST_ARGV_LOG: workspace.argvLog,
    COSENSECLI_TEST_REPLIES: JSON.stringify(options.replies ?? {}),
    ...(options.env ?? {}),
  };
  delete env.COSENSE_PAT;
  if (options.env?.COSENSE_PAT !== undefined) {
    env.COSENSE_PAT = options.env.COSENSE_PAT;
  }
  return env;
}

export function runCli(
  workspace: Workspace,
  args: string[],
  options: RunOptions = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: baseEnv(workspace, options),
    timeout: 60_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

export type McpToolCall = { name: string; arguments?: Record<string, unknown> };

export type McpResponse = {
  id: number;
  result?: any;
  error?: { code: number; message: string };
};

/**
 * Speaks JSON-RPC to `cosensecli --mcp-server` over a pipe, so the tests cover
 * the framing as well as the tools.
 */
export async function runMcp(
  workspace: Workspace,
  calls: McpToolCall[],
  options: RunOptions = {},
): Promise<{ initialize: any; tools: any[]; responses: McpResponse[]; stderr: string }> {
  const requests: string[] = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'cosensecli-test', version: '0' },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ];
  calls.forEach((call, index) => {
    requests.push(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3 + index,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments ?? {} },
      }),
    );
  });

  const result = spawnSync(process.execPath, [CLI_PATH, '--mcp-server'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: baseEnv(workspace, options),
    input: `${requests.join('\n')}\n`,
    timeout: 60_000,
  });

  const messages: McpResponse[] = result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return {
    initialize: messages.find((message) => message.id === 1)?.result,
    tools: messages.find((message) => message.id === 2)?.result?.tools ?? [],
    responses: messages.filter((message) => message.id >= 3),
    stderr: result.stderr,
  };
}

/** The first text block of a tool result. */
export function toolText(response: McpResponse): string {
  return response.result.content[0].text;
}
