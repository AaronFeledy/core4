import { Effect, Option, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, AppPlan, type AppPlan as AppPlanShape, type AppliedStateInventory } from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";

import { APPLIED_PLAN_NAMESPACE, listAppliedPlanInventory } from "./applied-state-inventory.ts";
import {
  APPLIED_STATE_VERSION,
  migrateAppliedPlan,
  migrateAppliedPlansRecord,
} from "./applied-state-migrate.ts";
import {
  type AppliedPlanRead,
  inspectAppliedPlanBucket,
  inspectAppliedPlansRecordBucket,
  unreadableAppliedStateError,
} from "./applied-state-read.ts";

export { appliedPlanPath, appliedPlansDir } from "./applied-state-inventory.ts";
export { type AppliedPlanRead, unreadableAppliedStateError } from "./applied-state-read.ts";
export {
  APPLIED_STATE_VERSION,
  migrateAppliedPlan,
  migrateAppliedPlansRecord,
} from "./applied-state-migrate.ts";

const APPLIED_PLANS_KEY = "applied-plans.json";
const AppliedPlans = Schema.Record(AppId, AppPlan);

/**
 * Applied state records what the provider realized. Landofile events are not
 * provider state: lifecycle operations resolve them from the current Landofile,
 * so a record never carries hooks that could run stale.
 */
const appliedPlanRecord = Effect.fnUntraced(function* (plan: AppPlanShape) {
  const sanitizer = yield* Effect.serviceOption(AppPlanSanitizer);
  const { events: _events, ...applied } = Option.isSome(sanitizer)
    ? sanitizer.value.sanitizeForPersistence(plan)
    : plan;
  return applied;
});

interface AppliedPlanOperations {
  readonly inspectAppliedPlan: (stateStore: PluginStateStore, appId: AppId) => Effect.Effect<AppliedPlanRead>;
  readonly loadAppliedPlanStrict: (
    stateStore: PluginStateStore,
    appId: AppId,
  ) => Effect.Effect<AppPlanShape | undefined, ProviderUnavailableError>;
  readonly persistAppliedPlan: (
    stateStore: PluginStateStore,
    plan: AppPlanShape,
  ) => Effect.Effect<string, ProviderUnavailableError>;
  readonly loadAppliedPlan: (
    stateStore: PluginStateStore,
    appId: AppId,
  ) => Effect.Effect<AppPlanShape | undefined, never>;
  readonly removeAppliedPlan: (
    stateStore: PluginStateStore,
    appId: AppId,
  ) => Effect.Effect<void, ProviderUnavailableError>;
}

export interface PerAppAppliedPlanStore extends AppliedPlanOperations {
  readonly listObservedPlans: (
    stateStore: PluginStateStore,
    stateDir: string,
  ) => Effect.Effect<ReadonlyArray<AppPlanShape>>;
  readonly listAppliedPlans: (
    stateStore: PluginStateStore,
    stateDir: string,
  ) => Effect.Effect<AppliedStateInventory, ProviderUnavailableError>;
}

export interface RecordAppliedPlanStore extends AppliedPlanOperations {
  readonly listObservedPlans: (stateStore: PluginStateStore) => Effect.Effect<ReadonlyArray<AppPlanShape>>;
  readonly listAppliedPlans: (
    stateStore: PluginStateStore,
  ) => Effect.Effect<AppliedStateInventory, ProviderUnavailableError>;
}

interface AppliedPlanStoreOptions {
  readonly providerId: "docker" | "lando" | "podman";
  readonly layout: "per-app" | "record";
}

export function makeAppliedPlanStore(options: {
  readonly providerId: "docker" | "lando" | "podman";
  readonly layout: "per-app";
}): PerAppAppliedPlanStore;
export function makeAppliedPlanStore(options: {
  readonly providerId: "docker" | "lando" | "podman";
  readonly layout: "record";
}): RecordAppliedPlanStore;
export function makeAppliedPlanStore(
  options: AppliedPlanStoreOptions,
): PerAppAppliedPlanStore | RecordAppliedPlanStore {
  const error = (operation: "list" | "persist" | "remove", cause: unknown) =>
    new ProviderUnavailableError({
      providerId: options.providerId,
      operation: `applied-state.${operation}`,
      message: `${operation === "list" ? "Unable to inspect" : operation === "persist" ? "Unable to write" : "Unable to remove"} provider-${options.providerId} applied plan state.`,
      remediation: `Check permissions for the provider-${options.providerId} plugin state directory and retry.`,
      cause,
    });

  if (options.layout === "per-app") {
    const open = (stateStore: PluginStateStore, appId: AppId) =>
      stateStore.open({
        namespace: APPLIED_PLAN_NAMESPACE,
        key: `${appId}.json`,
        schema: AppPlan,
        version: APPLIED_STATE_VERSION,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "fail",
        onVersionMismatch: migrateAppliedPlan,
      });
    const inspectAppliedPlan = (stateStore: PluginStateStore, appId: AppId): Effect.Effect<AppliedPlanRead> =>
      inspectAppliedPlanBucket(open(stateStore, appId), `${APPLIED_PLAN_NAMESPACE}/${appId}.json`);
    const loadAppliedPlanStrict = (stateStore: PluginStateStore, appId: AppId) =>
      inspectAppliedPlan(stateStore, appId).pipe(
        Effect.flatMap((read) => {
          switch (read.status) {
            case "missing":
              return Effect.succeed(undefined);
            case "readable":
              return Effect.succeed(read.plan);
            case "unreadable":
              return Effect.fail(unreadableAppliedStateError({ ...options, path: read.path }));
          }
        }),
      );
    const loadAppliedPlan = (stateStore: PluginStateStore, appId: AppId) =>
      loadAppliedPlanStrict(stateStore, appId).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const list = (stateStore: PluginStateStore, stateDir: string) =>
      listAppliedPlanInventory(
        stateDir,
        (appId) => inspectAppliedPlan(stateStore, appId),
        (cause) => error("list", cause),
      );
    return {
      inspectAppliedPlan,
      loadAppliedPlanStrict,
      loadAppliedPlan,
      listAppliedPlans: list,
      listObservedPlans: (stateStore, stateDir) =>
        list(stateStore, stateDir).pipe(
          Effect.map((inventory) => inventory.plans),
          Effect.catch(() => Effect.succeed([])),
        ),
      persistAppliedPlan: (stateStore, plan) =>
        open(stateStore, plan.id).pipe(
          Effect.flatMap((bucket) =>
            appliedPlanRecord(plan).pipe(
              Effect.flatMap((applied) => bucket.set(applied)),
              Effect.as(bucket.path),
            ),
          ),
          Effect.mapError((cause) => error("persist", cause)),
        ),
      removeAppliedPlan: (stateStore, appId) =>
        open(stateStore, appId).pipe(
          Effect.flatMap((bucket) => bucket.remove),
          Effect.mapError((cause) => error("remove", cause)),
        ),
    };
  }

  const open = (stateStore: PluginStateStore) =>
    stateStore.open({
      key: APPLIED_PLANS_KEY,
      schema: AppliedPlans,
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
      onVersionMismatch: migrateAppliedPlansRecord,
    });
  const inspectRecord = (stateStore: PluginStateStore) =>
    inspectAppliedPlansRecordBucket(open(stateStore), APPLIED_PLANS_KEY);
  const readRecord = (stateStore: PluginStateStore) =>
    inspectRecord(stateStore).pipe(
      Effect.flatMap((read) => {
        switch (read.status) {
          case "unreadable":
            return Effect.fail(unreadableAppliedStateError({ ...options, path: read.path }));
          case "readable":
            return Effect.succeed(read.plans);
        }
      }),
    );
  const loadAppliedPlanStrict = (stateStore: PluginStateStore, appId: AppId) =>
    readRecord(stateStore).pipe(Effect.map((plans) => plans?.[appId]));
  return {
    loadAppliedPlanStrict,
    inspectAppliedPlan: (stateStore, appId) =>
      inspectRecord(stateStore).pipe(
        Effect.map((read): AppliedPlanRead => {
          switch (read.status) {
            case "unreadable":
              return read;
            case "readable": {
              const plan = read.plans?.[appId];
              return plan === undefined ? { status: "missing" } : { status: "readable", plan };
            }
          }
        }),
      ),
    persistAppliedPlan: (stateStore, plan) =>
      open(stateStore).pipe(
        Effect.flatMap((bucket) =>
          appliedPlanRecord(plan).pipe(
            Effect.flatMap((applied) =>
              bucket.modify((current) => [bucket.path, { ...(current ?? {}), [plan.id]: applied }]),
            ),
          ),
        ),
        Effect.mapError((cause) => error("persist", cause)),
      ),
    loadAppliedPlan: (stateStore, appId) =>
      loadAppliedPlanStrict(stateStore, appId).pipe(Effect.catch(() => Effect.succeed(undefined))),
    listAppliedPlans: (stateStore: PluginStateStore) =>
      inspectRecord(stateStore).pipe(
        Effect.map((read): AppliedStateInventory => {
          switch (read.status) {
            case "readable":
              return { plans: Object.values(read.plans ?? {}), unreadable: [] };
            case "unreadable":
              return { plans: [], unreadable: [{ path: read.path }] };
          }
        }),
      ),
    listObservedPlans: (stateStore: PluginStateStore) =>
      readRecord(stateStore).pipe(
        Effect.map((plans) => Object.values(plans ?? {})),
        Effect.catch(() => Effect.succeed([])),
      ),
    removeAppliedPlan: (stateStore, appId) =>
      open(stateStore).pipe(
        Effect.flatMap((bucket) =>
          bucket.modify((current) => {
            const { [appId]: _removed, ...remaining } = current ?? {};
            return [undefined, remaining];
          }),
        ),
        Effect.mapError((cause) => error("remove", cause)),
      ),
  };
}
