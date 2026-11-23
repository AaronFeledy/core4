import { dirname } from "node:path";
import { managedHealthUnitPrefix } from "@lando/container-runtime/podman/managed-health-units";
import { managedRuntimeDirForTeardown } from "@lando/container-runtime/podman/managed-runtime-dir";
import type { HostMaintenanceContribution, PluginStateStore } from "@lando/sdk/plugins";
import { hostPlatformFamily } from "@lando/sdk/schema";
import { Effect } from "effect";
import { type DelegatedScopeHost, systemDelegatedScopeHost, userSystemdTools } from "./delegated-scope.ts";
import { buildManagedRuntimeServiceSpec, terminateOwnedRuntimeService } from "./managed-runtime-service.ts";
import { nativeHealthLock } from "./native-health-provider.ts";
import { processUserSystemd, removeNativeHealthTimers } from "./native-health-timers.ts";
import { makeRuntimeShutdownStore } from "./runtime-shutdown.ts";

// The receipt is evidence for a later status read, never a precondition for stopping:
// when the lock or receipt store fails before teardown ran, poweroff still stops the runtime.
export const withRuntimeShutdownReceipt = (
  stateStore: PluginStateStore,
  teardown: ReturnType<typeof terminateOwnedRuntimeService>,
) => {
  let completed: Effect.Success<typeof teardown> | undefined;
  return stateStore
    .withLock(
      "runtime-launch",
      Effect.gen(function* () {
        const receipt = yield* makeRuntimeShutdownStore(stateStore);
        const before = yield* receipt.read.pipe(Effect.catch(() => Effect.succeed(null)));
        const result = yield* teardown;
        completed = result;
        if (result.quiescent === true && before !== null) {
          yield* receipt.quiesce(before.generation).pipe(Effect.catch(() => Effect.void));
        }
        return result;
      }),
      { wait: "operation", resource: "the Lando container runtime" },
    )
    .pipe(Effect.catch(() => (completed === undefined ? teardown : Effect.succeed(completed))));
};

type TeardownInput = Parameters<NonNullable<HostMaintenanceContribution["teardown"]>>[0];

export interface HealthTimerTeardownSeams {
  readonly host?: DelegatedScopeHost;
  /** Private runtime dir of a runtime dir: the launch record's first, then the current resolution. */
  readonly privateRuntimeDir?: (runtimeDir: string) => Effect.Effect<string | undefined>;
}

/**
 * Stops every native health timer of this data root's runtime before the service stops. Undefined
 * when no user manager is reachable, so no timer can exist. Best effort and bounded: it waits only
 * briefly for the timer lock, teardown cannot fail and reports no detail, and the timers also stop
 * with the service's scope or at reboot.
 */
export const removeHealthTimers = (
  input: TeardownInput,
  seams: HealthTimerTeardownSeams = {},
): Effect.Effect<void> | undefined => {
  const tools = userSystemdTools(input.platform, seams.host ?? systemDelegatedScopeHost);
  if (typeof tools === "string") return undefined;
  return (seams.privateRuntimeDir ?? managedRuntimeDirForTeardown)(dirname(input.paths.runtimeBinDir)).pipe(
    Effect.flatMap((privateDir) =>
      privateDir === undefined
        ? Effect.void
        : nativeHealthLock(
            input.stateStore,
            "brief",
          )(
            removeNativeHealthTimers(
              processUserSystemd(input.processRunner, tools.userRuntimeDir),
              tools.systemctl,
              managedHealthUnitPrefix(privateDir),
            ),
          ),
    ),
    Effect.catch(() => Effect.void),
  );
};

export const teardownManagedRuntime: NonNullable<HostMaintenanceContribution["teardown"]> = (input) => {
  const removeTimers = removeHealthTimers(input);
  const teardown = terminateOwnedRuntimeService(
    buildManagedRuntimeServiceSpec({ ...input.paths, platform: input.platform }),
    removeTimers === undefined ? {} : { removeHealthTimers: removeTimers },
  );
  return hostPlatformFamily(input.platform) === "linux"
    ? withRuntimeShutdownReceipt(input.stateStore, teardown)
    : teardown;
};
