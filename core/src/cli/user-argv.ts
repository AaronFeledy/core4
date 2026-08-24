/**
 * Resolve user CLI tokens from Bun/process argv.
 *
 * Source (`bun core/bin/lando.ts …`) and compiled virtual-FS launches insert an
 * entry path at argv[1]. POSIX compiled entries use `/$bunfs/…`; Windows uses
 * `B:\\~BUN\\…` / `B:/~BUN/…` (no `$bunfs` substring). A detached compiled
 * worker is spawned as `[execPath, __internal:host-proxy-worker, …]` with no
 * injected entry, so a fixed `slice(2)` drops the worker command.
 */
const ENTRY_PATH_SUFFIX = /\.(?:cjs|js|mjs|ts)$/u;

const isCompiledVirtualEntry = (value: string): boolean =>
  value.includes("$bunfs") || value.includes("~BUN");

export const cliUserArgv = (argv: ReadonlyArray<string>): string[] => {
  if (argv.length <= 1) return [];
  const maybeEntry = argv[1] ?? "";
  const looksLikeEntry =
    isCompiledVirtualEntry(maybeEntry) ||
    ENTRY_PATH_SUFFIX.test(maybeEntry) ||
    maybeEntry === argv[0];
  return looksLikeEntry ? argv.slice(2) : argv.slice(1);
};
