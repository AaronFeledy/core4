import { mapFailures } from "@lando/sdk/command-result";
import {
  type AppliedStateVersionError,
  ProviderUnavailableError,
  type StateStoreError,
} from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type {
  AppId,
  AppPlan,
  AppliedAppPlan,
  AppliedStateInventory,
  UnreadableAppliedState,
} from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { Effect, Option } from "effect";

import { AppliedPlan, AppliedPlans, requireMigrated } from "./applied-state-codec.ts";
import { APPLIED_PLAN_NAMESPACE, listAppliedPlanInventory } from "./applied-state-inventory.ts";
import {
  APPLIED_STATE_VERSION,
  migrateAppliedPlanWithCoordinate,
  migrateAppliedPlansRecordWithCoordinate,
} from "./applied-state-migrate.ts";
import {
  APPLIED_PLANS_KEY,
  type AppliedPlanRead,
  appliedStateInspectError,
  classifyAppliedStateStoreError,
  inspectAppliedPlanBucket,
  inspectAppliedPlansRecordBucket,
  unreadableEntryFromRead,
} from "./applied-state-read.ts";

export { appliedPlanPath, appliedPlansDir } from "./applied-state-inventory.ts";
export { APPLIED_STATE_VERSION, migrateAppliedPlan } from "./applied-state-migrate.ts";
export {
  type AppliedPlanRead,
  appliedStateInspectError,
  classifyAppliedStateStoreError,
  unreadableAppliedStateError,
  unreadableEntryFromRead,
} from "./applied-state-read.ts";

export type AppliedPlanStoreError = ProviderUnavailableError | AppliedStateVersionError;

export const inventoryProtectsApp = (entry: UnreadableAppliedState, appId: string): boolean =>
  entry.appId === undefined || entry.appId === appId;

export const protectedSlotError = (providerId: string, entry: UnreadableAppliedState, appId = entry.appId) =>
  appliedStateInspectError({
    providerId,
    ...(appId === undefined ? {} : { appId }),
    layout: entry.appId === undefined ? "record" : "per-app",
    read:
      entry.reason === "newer-version"
        ? { ...entry, status: "newer-version" }
        : { path: entry.path, status: "unreadable" },
  });

export const openAppliedPlansRecord = (stateStore: Pick<PluginStateStore, "open">) =>
  stateStore.open({
    key: APPLIED_PLANS_KEY,
    schema: AppliedPlans,
    version: APPLIED_STATE_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: (raw, version) =>
      requireMigrated(migrateAppliedPlansRecordWithCoordinate(raw, version), version),
  });

/**
 * Applied state records what the provider realized. Landofile events are not
 * provider state: lifecycle operations resolve them from the current Landofile,
 * so a record never carries hooks that could run stale.
 */
const appliedPlanRecord = Effect.fnUntraced(function* (plan: AppPlan): Effect.fn.Return<AppliedAppPlan> {
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
  ) => Effect.Effect<AppliedAppPlan | undefined, AppliedPlanStoreError>;
  readonly persistAppliedPlan: (
    stateStore: PluginStateStore,
    plan: AppPlan,
  ) => Effect.Effect<string, AppliedPlanStoreError>;
  readonly removeAppliedPlan: (
    stateStore: PluginStateStore,
    appId: AppId,
  ) => Effect.Effect<void, AppliedPlanStoreError>;
}

export interface PerAppAppliedPlanStore extends AppliedPlanOperations {
  readonly listAppliedPlans: (
    stateStore: PluginStateStore,
    stateDir: string,
  ) => Effect.Effect<AppliedStateInventory, AppliedPlanStoreError>;
}

export interface RecordAppliedPlanStore extends AppliedPlanOperations {
  readonly listAppliedPlans: (
    stateStore: PluginStateStore,
  ) => Effect.Effect<AppliedStateInventory, AppliedPlanStoreError>;
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
  const mutationError = (operation: "persist" | "remove", cause: StateStoreError, appId?: AppId) => {
    if (cause.reason !== "decode" && cause.reason !== "version" && cause.reason !== "newer-version") {
      return error(operation, cause);
    }
    const record = options.layout === "record";
    return appliedStateInspectError({
      ...options,
      operation,
      read: classifyAppliedStateStoreError(
        cause,
        record ? "apps" : "plan",
        appId === undefined || record ? APPLIED_PLANS_KEY : `${APPLIED_PLAN_NAMESPACE}/${appId}.json`,
      ),
      ...(appId === undefined ? {} : { appId }),
      cause,
    });
  };
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
        schema: AppliedPlan,
        version: APPLIED_STATE_VERSION,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "fail",
        onVersionMismatch: (raw, version) =>
          requireMigrated(migrateAppliedPlanWithCoordinate(raw, version), version),
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
            case "newer-version":
              return Effect.fail(appliedStateInspectError({ ...options, read, appId }));
            default: {
              const exhaustive: never = read;
              return exhaustive;
            }
          }
        }),
      );
    const list = (stateStore: PluginStateStore, stateDir: string) =>
      listAppliedPlanInventory(
        stateDir,
        (appId) => inspectAppliedPlan(stateStore, appId),
        (cause) => error("list", cause),
      );
    return {
      inspectAppliedPlan,
      loadAppliedPlanStrict,
      listAppliedPlans: list,
      persistAppliedPlan: (stateStore, plan) =>
        open(stateStore, plan.id).pipe(
          Effect.flatMap((bucket) =>
            appliedPlanRecord(plan).pipe(
              Effect.flatMap((applied) => bucket.set(applied)),
              Effect.as(bucket.path),
            ),
          ),
          mapFailures((cause) => mutationError("persist", cause, plan.id)),
        ),
      removeAppliedPlan: (stateStore, appId) =>
        open(stateStore, appId).pipe(
          Effect.flatMap((bucket) => bucket.remove),
          mapFailures((cause) => mutationError("remove", cause, appId)),
        ),
    };
  }

  const open = openAppliedPlansRecord;
  const inspectRecord = (stateStore: PluginStateStore) =>
    inspectAppliedPlansRecordBucket(open(stateStore), APPLIED_PLANS_KEY);
  const readRecord = (stateStore: PluginStateStore, appId?: AppId) =>
    inspectRecord(stateStore).pipe(
      Effect.flatMap((read) => {
        switch (read.status) {
          case "unreadable":
          case "newer-version":
            return Effect.fail(
              appliedStateInspectError({
                ...options,
                read,
                ...(appId === undefined ? {} : { appId }),
              }),
            );
          case "readable":
            return Effect.succeed(read.plans);
          default: {
            const exhaustive: never = read;
            return exhaustive;
          }
        }
      }),
    );
  const loadAppliedPlanStrict = (stateStore: PluginStateStore, appId: AppId) =>
    readRecord(stateStore, appId).pipe(Effect.map((plans) => plans?.[appId]));
  return {
    loadAppliedPlanStrict,
    inspectAppliedPlan: (stateStore, appId) =>
      inspectRecord(stateStore).pipe(
        Effect.map((read): AppliedPlanRead => {
          switch (read.status) {
            case "unreadable":
            case "newer-version":
              return read;
            case "readable": {
              const plan = read.plans?.[appId];
              return plan === undefined ? { status: "missing" } : { status: "readable", plan };
            }
            default: {
              const exhaustive: never = read;
              return exhaustive;
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
        mapFailures((cause) => mutationError("persist", cause)),
      ),
    listAppliedPlans: (stateStore: PluginStateStore) =>
      inspectRecord(stateStore).pipe(
        Effect.map((read): AppliedStateInventory => {
          switch (read.status) {
            case "readable":
              return { plans: Object.values(read.plans ?? {}), unreadable: [] };
            case "unreadable":
            case "newer-version":
              return { plans: [], unreadable: [unreadableEntryFromRead(read)] };
            default: {
              const exhaustive: never = read;
              return exhaustive;
            }
          }
        }),
      ),
    removeAppliedPlan: (stateStore, appId) =>
      open(stateStore).pipe(
        Effect.flatMap((bucket) =>
          bucket.mutate((current) => {
            if (current === null || !Object.hasOwn(current, appId)) {
              return Effect.succeed({ _tag: "Keep", result: undefined });
            }
            const { [appId]: _removed, ...remaining } = current;
            return Effect.succeed({ _tag: "Set", value: remaining, result: undefined });
          }),
        ),
        mapFailures((cause) => mutationError("remove", cause)),
      ),
  };
}
