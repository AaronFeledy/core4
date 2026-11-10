import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ownershipFailure } from "./resource-ownership.ts";

export const hasResourceOwnershipRecords = (providerId: string, pluginStateRoot: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return (await readdir(join(pluginStateRoot, "resource-ownership"))).some((name) =>
          name.endsWith(".json"),
        );
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
        throw cause;
      }
    },
    catch: (cause) => ownershipFailure(providerId, cause),
  });
