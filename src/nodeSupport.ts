/**
 * The oldest Node this CLI runs on.
 *
 * 24 is what `@helpfeel/cosense-cli` declares, and this package runs it as a
 * child process with the same interpreter, so the floor cannot be lower than
 * the thing it spawns. Below it the failure surfaces from inside the child,
 * where the message is about a package the user never installed directly.
 */
export const MINIMUM_NODE = '24.0.0';

/** Compares dotted version numbers, ignoring any prerelease suffix. */
export function isSupportedNodeVersion(
  version: string,
  minimum: string = MINIMUM_NODE,
): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number(part) || 0);

  const current = parse(version);
  const floor = parse(minimum);

  for (let index = 0; index < Math.max(current.length, floor.length); index += 1) {
    const left = current[index] ?? 0;
    const right = floor[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
