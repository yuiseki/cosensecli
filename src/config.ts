/**
 * The stored configuration.
 *
 * Only the default project lives here so far. It is not a secret, but it does
 * say which wiki someone reads, so the file is written the way the sibling
 * CLIs write their credentials rather than world-readable.
 *
 * Reading never creates a directory. The MCP server runs under a sandbox with
 * a read-only home, where an mkdir on the way to a file that is not there
 * takes the whole call down, so only `config set` asks for the directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type StoredConfig = {
  /** The project a call is about when it names none, as a full URL. */
  default?: string;
};

export function configDir(options: { create?: boolean } = {}): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ''
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  const dir = path.join(base, 'cosensecli');
  if (options.create && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function configPath(options: { create?: boolean } = {}): string {
  return path.join(configDir(options), 'projects.json');
}

export function loadConfig(): StoredConfig {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Not silently ignored. A file that is there but unreadable is a different
    // situation from no file at all, and defaulting to "no project configured"
    // would send the user looking at the wrong thing.
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  return parsed as StoredConfig;
}

export function saveConfig(config: StoredConfig): string {
  const file = configPath({ create: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}
