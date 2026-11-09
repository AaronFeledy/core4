import type { HostMaintenanceContribution, PluginStateStore } from "@lando/sdk/plugins";
import { hostPlatformFamily } from "@lando/sdk/schema";
import { Effect } from "effect";
import { buildManagedRuntimeServiceSpec, terminateOwnedRuntimeService } from "./managed-runtime-service.ts";
import { makeRuntimeShutdownStore } from "./runtime-shutdown.ts";

export const withRuntimeShutdownReceipt = (
  stateStore: PluginStateStore,
  teardown: ReturnType<typeof terminateOwnedRuntimeService>,
) =>
  stateStore
    .withLock(
      "runtime-launch",
      Effect.gen(function* () {
        const receipt = yield* makeRuntimeShutdownStore(stateStore);
        const before = yield* receipt.read.pipe(Effect.catch(() => Effect.succeed(null)));
        const result = yield* teardown;
        if (result.quiescent === true && before !== null) {
          yield* receipt.quiesce(before.generation).pipe(Effect.catch(() => Effect.void));
        }
        return result;
      }),
    )
    .pipe(Effect.catch(() => Effect.succeed({ terminated: false })));

export const teardownManagedRuntime: NonNullable<HostMaintenanceContribution["teardown"]> = (input) => {
  const teardown = terminateOwnedRuntimeService(
    buildManagedRuntimeServiceSpec({ ...input.paths, platform: input.platform }),
  );
  return hostPlatformFamily(input.platform) === "linux"
    ? withRuntimeShutdownReceipt(input.stateStore, teardown)
    : teardown;
};
