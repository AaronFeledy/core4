import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

/** Stat follows symlinks; inaccessible or missing host files do not block agent forwarding. */
export const hostKnownHostsFile = (
  home: string,
  inspect: (path: string) => Promise<{ readonly isFile: () => boolean }> = stat,
): Effect.Effect<string | undefined> => {
  const path = join(home, ".ssh", "known_hosts");
  return Effect.tryPromise(() => inspect(path)).pipe(
    Effect.map((stats) => (stats.isFile() ? path : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
};
