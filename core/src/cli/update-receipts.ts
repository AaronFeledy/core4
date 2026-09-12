import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { makeUpdateHandoff } from "@lando/engine/operations/update";
import { resolveLandoRoots } from "@lando/paths";
import { writeStdioLine } from "@lando/renderer/io";
import { StateStore } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect } from "effect";
import { renderUpdateResult } from "./command-specs/meta/update.ts";

export const surfaceDeferredUpdateReceipts = async (): Promise<void> => {
  const receipts = await Effect.runPromise(
    Effect.gen(function* () {
      const handoff = makeUpdateHandoff(yield* StateStore);
      const names = yield* Effect.tryPromise(() =>
        readdir(join(resolveLandoRoots().userCacheRoot, "update-handoff")).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
          throw cause;
        }),
      );
      return yield* Effect.forEach(
        names.filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name)),
        (name) => handoff.consumeDeferred(name.slice(0, -5)),
      );
    }).pipe(Effect.provide(StateStoreLive)),
  );
  for (const receipt of receipts) {
    if (receipt === undefined) continue;
    writeStdioLine("stderr", `Previous Windows update result:\n${renderUpdateResult(receipt)}`);
  }
  await rmdir(join(resolveLandoRoots().userCacheRoot, "update-handoff")).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && (cause.code === "ENOTEMPTY" || cause.code === "ENOENT"))
      return;
    throw cause;
  });
};
