/**
 * Resolve user CLI tokens from Bun/process argv.
 *
 * Source (`bun core/bin/lando.ts …`) and compiled `$bunfs` launches insert an
 * entry path at argv[1]. A detached compiled worker is spawned as
 * `[execPath, __internal:host-proxy-worker, …]` with no injected entry, so a
 * fixed `slice(2)` drops the worker command and the child exits immediately.
 */
const ENTRY_PATH_SUFFIX = /\.(?:cjs|js|mjs|ts)$/u;

export const cliUserArgv = (argv: ReadonlyArray<string>): string[] => {
  if (argv.length <= 1) return [];
  const maybeEntry = argv[1] ?? "";
  const looksLikeEntry =
    maybeEntry.includes("$bunfs") || ENTRY_PATH_SUFFIX.test(maybeEntry) || maybeEntry === argv[0];
  return looksLikeEntry ? argv.slice(2) : argv.slice(1);
};
