import { Effect, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, AppPlan } from "@lando/sdk/schema";

const PROVIDER_ID = "podman";
const APPLIED_STATE_VERSION = 1;

const AppliedPlans = Schema.Record({ key: AppId, value: AppPlan });

const openAppliedPlans = (stateStore: PluginStateStore) =>
  stateStore.open({
    key: "applied-plans.json",
    schema: AppliedPlans,
    version: APPLIED_STATE_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "discard",
    onVersionMismatch: "discard",
    default: {},
  });

export const persistAppliedPlan = (
  stateStore: PluginStateStore,
  plan: AppPlan,
): Effect.Effect<string, ProviderUnavailableError> =>
  openAppliedPlans(stateStore).pipe(
    Effect.flatMap((bucket) =>
      bucket.modify((current) => [bucket.path, { ...(current ?? {}), [plan.id]: plan }]),
    ),
    Effect.mapError(
      (cause) =>
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "applied-state.persist",
          message: "Unable to write provider-podman applied plan state.",
          remediation: "Check permissions for the provider-podman plugin state directory and retry.",
          cause,
        }),
    ),
  );

export const loadAppliedPlan = (
  stateStore: PluginStateStore,
  appId: AppId,
): Effect.Effect<AppPlan | undefined, never> =>
  openAppliedPlans(stateStore).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((plans) => plans?.[appId]),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

export const listAppliedPlans = (
  stateStore: PluginStateStore,
): Effect.Effect<ReadonlyArray<AppPlan>, never> =>
  openAppliedPlans(stateStore).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((plans) => Object.values(plans ?? {})),
    Effect.catchAll(() => Effect.succeed([])),
  );

export const removeAppliedPlan = (stateStore: PluginStateStore, appId: AppId): Effect.Effect<void, never> =>
  openAppliedPlans(stateStore).pipe(
    Effect.flatMap((bucket) =>
      bucket.modify((current) => {
        const { [appId]: _removed, ...remaining } = current ?? {};
        return [undefined, remaining];
      }),
    ),
    Effect.catchAll(() => Effect.void),
  );
