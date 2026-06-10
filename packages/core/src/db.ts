/**
 * Default DB path: ~/.memharness/memory.db, honoring XDG_DATA_HOME on Linux.
 * platform/env are injectable for tests.
 */
export function resolveDefaultDbPath(
  _platform: NodeJS.Platform = process.platform,
  _env: Record<string, string | undefined> = process.env,
): string {
  throw new Error("not implemented");
}
