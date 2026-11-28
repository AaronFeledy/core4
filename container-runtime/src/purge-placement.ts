import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore, ProviderPurgePreflight } from "@lando/sdk/plugins";
import type { AppliedStateInventory, EngineIdentity } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import type { AppliedPlanStoreError } from "./applied-state.ts";
import { type DataRootPurgeOptions, preflightDataRootPurge } from "./data-root-purge.ts";
import type { EngineApiClient, ProviderErrorContext } from "./engine-api.ts";
import { engineEndpointDisplay, matchesEnginePlacement } from "./engine-identity.ts";
import { listResourceOwnershipRecords, openPurgeState } from "./resource-ownership-records.ts";

type ListAppliedPlans = (
  state: PluginStateStore,
  root: string,
) => Effect.Effect<AppliedStateInventory, AppliedPlanStoreError>;

// Purge runs without bootstrapping a runtime provider.
const guardPurgePlacement = Effect.fn("DataRootPurge.guardPlacement")(function* (
  providerId: string,
  input: { readonly dataRoot: string; readonly pluginId: string },
  inventory: ListAppliedPlans,
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
  const observation = unreadable.length
    ? { ...found, unreadableAppliedState: unreadable.map(({ path }) => path) }
    : found;

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
      `Reconnect to ${endpoints} and retry. If an engine is gone for good, run \`lando destroy --provider=${providerId} --yes\` in each of its apps first to drop Lando's record.`,
    );
  });
  yield* prove;
  if (observation.kind === "skipped") {
    if (plans.length || (yield* listResourceOwnershipRecords(providerId, pluginRoot, state)).length)
      return yield* failure(
        `Purge skipped ${found.endpoint}, but ${providerId} still has recorded resources.`,
        `Restore access to the ${providerId} engine that holds those resources and retry purge. If that engine is gone for good, run \`lando destroy --provider=${providerId} --yes\` in each of its apps first to drop Lando's record.`,
      );
    return observation;
  }
  if (!claims.length) return observation;
  return {
    ...observation,
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
      return yield* observation.sweep();
    }),
  };
});

export const preflightRecordedPurge = Effect.fn("DataRootPurge.preflightRecorded")(function* (
  ctx: ProviderErrorContext,
  input: Omit<DataRootPurgeOptions, "endpoint">,
  inventory: ListAppliedPlans,
  connection:
    | Extract<ProviderPurgePreflight, { kind: "skipped" }>
    | {
        readonly api: EngineApiClient;
        readonly endpoint: string;
        readonly identify: (info: unknown, endpoint: string) => EngineIdentity | undefined;
      },
) {
  if ("kind" in connection) return yield* guardPurgePlacement(ctx.providerId, input, inventory, connection);
  const { api, endpoint, identify } = connection;
  const found = yield* preflightDataRootPurge(api, ctx, { ...input, endpoint });
  const current = api.info.pipe(
    Effect.timeout("2 seconds"),
    Effect.map((info) => identify(info, endpoint)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  return yield* guardPurgePlacement(ctx.providerId, input, inventory, found, current);
});
