import { Effect, Schema } from "effect";

import type { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, AppPlan } from "@lando/sdk/schema";
import type { LandoPaths, StateStoreShape } from "@lando/sdk/services";

const APPLIED_STATE_VERSION = 1;
const APPLIED_PLAN_NAMESPACE = "applied-plans";
const AppliedPlans = Schema.Record({ key: AppId, value: AppPlan });

const pluginIdForProvider = (providerId: string): string | undefined => {
  switch (providerId) {
    case "lando":
    case "docker":
    case "podman":
      return `@lando/provider-${providerId}`;
    default:
      return undefined;
  }
};

export const pruneAppliedPlanState = (
  paths: LandoPaths,
  stateStore: StateStoreShape,
  appId: string,
  providerId: string,
): Effect.Effect<boolean, StateStoreError> => {
  const pluginId = pluginIdForProvider(providerId);
  if (pluginId === undefined) return Effect.succeed(false);
  const root = { path: AbsolutePath.make(paths.pluginStateDir(pluginId)) };
  const id = AppId.make(appId);

  if (providerId === "podman") {
    return stateStore
      .open({
        root,
        key: "applied-plans.json",
        schema: AppliedPlans,
        version: APPLIED_STATE_VERSION,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "discard",
        onVersionMismatch: "discard",
        default: {},
      })
      .pipe(
        Effect.flatMap((bucket) =>
          bucket.modify((current) => {
            const plans = current ?? {};
            if (!(id in plans)) return [false, plans];
            const { [id]: _removed, ...remaining } = plans;
            return [true, remaining];
          }),
        ),
      );
  }

  return stateStore
    .open({
      root,
      namespace: APPLIED_PLAN_NAMESPACE,
      key: `${id}.json`,
      schema: AppPlan,
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "discard",
      onVersionMismatch: "discard",
    })
    .pipe(
      Effect.flatMap((bucket) =>
        bucket.exists.pipe(
          Effect.flatMap((exists) => (exists ? bucket.remove.pipe(Effect.as(true)) : Effect.succeed(false))),
        ),
      ),
    );
};
