import { join } from "node:path";
import { Effect, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, AppPlan } from "@lando/sdk/schema";
import type { LandoPaths, StateStoreShape } from "@lando/sdk/services";
import { FileSystem } from "@lando/sdk/services";

import type { AppsListEntry } from "./list-discovery";

const APPLIED_STATE_VERSION = 1;
const APPLIED_PLAN_NAMESPACE = "applied-plans";
const AppliedPlanIdentity = Schema.Struct({
  id: AppId,
  root: AbsolutePath,
});
const AppliedPlans = Schema.Record({ key: AppId, value: AppPlan });
const LegacyAppliedPlan = Schema.Struct({
  version: Schema.Literal(1),
  providerId: Schema.optional(Schema.String),
  plan: Schema.Struct({
    id: AppId,
    root: AbsolutePath,
    provider: Schema.optional(Schema.String),
  }),
});

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
  entry: AppsListEntry,
): Effect.Effect<boolean, StateStoreError, FileSystem> => {
  const { appId, providerId } = entry;
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
          bucket.get.pipe(
            Effect.flatMap((current) => {
              const plans = current ?? {};
              const plan = plans[id];
              if (plan === undefined || plan.root !== entry.appRoot) return Effect.succeed(false);
              return bucket.modify((latest) => {
                const next = latest ?? {};
                const currentPlan = next[id];
                if (currentPlan === undefined || currentPlan.root !== entry.appRoot) return [false, next];
                const { [id]: _removed, ...remaining } = next;
                return [true, remaining];
              });
            }),
          ),
        ),
      );
  }

  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const namespace = `providers/provider-${providerId}/apps`;
    const directory = join(paths.roots.userDataRoot, namespace);
    const names = yield* fs.readDir(directory).pipe(
      Effect.catchTag("FileNotFoundError", () => Effect.succeed([])),
      Effect.mapError(
        (cause) => new StateStoreError({ reason: "io", operation: "readDir", path: directory, cause }),
      ),
    );
    let removedLegacy = false;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const bucket = yield* stateStore.open({
        root: { path: AbsolutePath.make(directory) },
        key: name,
        schema: LegacyAppliedPlan,
        version: APPLIED_STATE_VERSION,
        codec: {
          encode: JSON.stringify,
          decode: (raw) =>
            Schema.decodeUnknownSync(Schema.parseJson(LegacyAppliedPlan))(new TextDecoder().decode(raw)),
        },
        lock: "advisory",
        onCorrupt: "fail",
      });
      const record = yield* bucket.get;
      if (record === null || record.plan.id !== id) continue;
      if (
        record.plan.root !== entry.appRoot ||
        (record.providerId !== undefined && record.providerId.replace(/^provider-/u, "") !== providerId) ||
        (record.plan.provider !== undefined && record.plan.provider.replace(/^provider-/u, "") !== providerId)
      ) {
        return yield* Effect.fail(
          new StateStoreError({
            reason: "decode",
            operation: "prune",
            path: bucket.path,
            remediation: "Resolve the conflicting app root or provider in legacy inventory before pruning.",
          }),
        );
      }
      yield* bucket.remove;
      removedLegacy = true;
    }
    const removedModern = yield* stateStore
      .open({
        root,
        namespace: APPLIED_PLAN_NAMESPACE,
        key: `${id}.json`,
        schema: AppliedPlanIdentity,
        version: APPLIED_STATE_VERSION,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "discard",
        onVersionMismatch: "discard",
      })
      .pipe(
        Effect.flatMap((bucket) =>
          bucket.get.pipe(
            Effect.flatMap((plan) => {
              if (plan === null || plan.root !== entry.appRoot) return Effect.succeed(false);
              return bucket.remove.pipe(Effect.as(true));
            }),
          ),
        ),
      );
    return removedModern || removedLegacy;
  });
};
