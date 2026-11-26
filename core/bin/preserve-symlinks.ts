/**
 * `NODE_PRESERVE_SYMLINKS` and `--preserve-symlinks` make Bun keep each workspace package's
 * `node_modules` symlink path, so a module reached through `@lando/sdk` and through a relative
 * path loads twice and errors from one copy fail `instanceof` checks against the other. Bun reads
 * the setting once at startup, so a running process cannot undo it: source entry points refuse.
 */
export const preservedSymlinksMessage = (
  env: Readonly<Record<string, string | undefined>>,
  execArgv: ReadonlyArray<string>,
): string | undefined => {
  const value = env.NODE_PRESERVE_SYMLINKS;
  const fromEnv = value !== undefined && value !== "" && value !== "0";
  if (!fromEnv && !execArgv.includes("--preserve-symlinks")) return undefined;
  const fix = fromEnv
    ? "Put `env -u NODE_PRESERVE_SYMLINKS` in front of the command, or remove the export from your shell profile."
    : "Run the command without --preserve-symlinks.";
  return `Lando's source tree cannot run with preserved symlinks: Bun would load each workspace package twice, and errors from one copy fail checks against the other. ${fix}`;
};
