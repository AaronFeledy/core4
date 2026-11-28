import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore, ProviderPurgePreflight } from "@lando/sdk/plugins";
import type { AppliedStateInventory, EngineIdentity } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import type { AppliedPlanStoreError } from "./applied-state.ts";
import { engineEndpointDisplay, matchesEnginePlacement } from "./engine-identity.ts";
import { listResourceOwnershipRecords, openPurgeState } from "./resource-ownership-records.ts";

/** Purge is descriptor-only. Read the same durable records as placement without bootstrapping a runtime. */
export const guardPurgePlacement = Effect.fn("DataRootPurge.guardPlacement")(function* (
  providerId: string,
  input: { readonly dataRoot: string; readonly pluginId: string },
  inventory: (
    state: PluginStateStore,
    root: string,
  ) => Effect.Effect<AppliedStateInventory, AppliedPlanStoreError>,
  found: ProviderPurgePreflight,
  current?: Effect.Effect<EngineIdentity | undefined>,
) {
  const { state, pluginRoot } = yield* openPurgeState(providerId, input);
  const failure = (message: string, remediation: string) =>
    new ProviderUnavailableError({
      providerId,
      operation: "uninstall.purge",
      message,
      remediation,
    });
  const { plans, unreadable } = yield* inventory(state, pluginRoot).pipe(
    mapFailures((cause) => failure(cause.message, cause.remediation)),
  );
  const protectedSlot = unreadable[0];
  if (protectedSlot !== undefined)
    return yield* failure(
      `Cannot verify the engine recorded in ${protectedSlot.path}.`,
      "Restore readable applied state before retrying purge.",
    );

  const claims = plans.flatMap(({ engineIdentity }) =>
    engineIdentity === undefined ? [] : [engineIdentity],
  );
  const prove = Effect.gen(function* () {
    if (!claims.length) return;
    const selected = found.kind === "reachable" && current !== undefined ? yield* current : undefined;
    const missing = claims.filter(
      (claim) => selected === undefined || !matchesEnginePlacement(claim, selected),
    );
    if (!missing.length) return;
    const endpoints = [...new Set(missing.map(({ endpoint }) => engineEndpointDisplay(endpoint)))].join(", ");
    return yield* failure(
      `Purge at ${found.endpoint} cannot verify all recorded ${providerId} engines: ${endpoints}.`,
      `Reconnect to ${endpoints} and retry. If multiple engines hold apps, destroy those realizations on their owning engines before purging.`,
    );
  });
  yield* prove;
  if (found.kind === "skipped") {
    if (plans.length || (yield* listResourceOwnershipRecords(providerId, pluginRoot, state)).length)
      return yield* failure(
        `Purge skipped ${found.endpoint}, but ${providerId} still has recorded resources.`,
        `Restore access to the ${providerId} engine that holds those resources and retry purge.`,
      );
    return found;
  }
  if (!claims.length) return found;
  return {
    ...found,
    sweep: Effect.fn("DataRootPurge.sweepRecorded")(function* () {
      const result = yield* Effect.result(prove);
      if (Result.isFailure(result))
        return {
          endpoint: found.endpoint,
          removed: [],
          retained: [result.failure.message],
          failed: [],
          outsideScope: 0,
        };
      return yield* found.sweep();
    }),
  };
});
