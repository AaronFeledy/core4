import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

/** Stat follows symlinks; inaccessible or missing host files do not block agent forwarding. */
export const hostKnownHostsFile = (
  home: string,
  inspect: (path: string) => Promise<{
    readonly isFile: () => boolean;
    readonly dev: bigint;
    readonly ino: bigint;
  }> = (path) => stat(path, { bigint: true }),
): Effect.Effect<{ readonly path: string; readonly sourceIdentity: string } | undefined> => {
  const path = join(home, ".ssh", "known_hosts");
  return Effect.tryPromise(() => inspect(path)).pipe(
    Effect.map((stats) =>
      stats.isFile() ? { path, sourceIdentity: `${stats.dev}:${stats.ino}` } : undefined,
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
};
