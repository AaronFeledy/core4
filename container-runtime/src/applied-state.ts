import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { isPlainRecord } from "@lando/sdk/landofile";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, AppPlan, type AppPlan as AppPlanShape, type AppliedStateInventory } from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { Effect, Option, Schema } from "effect";

import { visitAppliedNetworkVocabulary } from "./applied-network-vocabulary.ts";
import { APPLIED_PLAN_NAMESPACE, listAppliedPlanInventory } from "./applied-state-inventory.ts";
import {
  APPLIED_STATE_VERSION,
  migrateAppliedPlanWithCoordinate,
  migrateAppliedPlansRecordWithCoordinate,
} from "./applied-state-migrate.ts";
import {
  type AppliedPlanRead,
  AppliedStateMigrationError,
  inspectAppliedPlanBucket,
  inspectAppliedPlansRecordBucket,
  unreadableAppliedStateError,
} from "./applied-state-read.ts";

export { appliedPlanPath, appliedPlansDir } from "./applied-state-inventory.ts";
export {
  APPLIED_STATE_VERSION,
  migrateAppliedPlan,
  migrateAppliedPlansRecord,
} from "./applied-state-migrate.ts";
export { type AppliedPlanRead, unreadableAppliedStateError } from "./applied-state-read.ts";

const APPLIED_PLANS_KEY = "applied-plans.json";
const currentPlanIssue = (raw: unknown) => {
  const checked = visitAppliedNetworkVocabulary(raw, false);
  return typeof checked === "string" ? checked : undefined;
};
const currentMapIssue = (raw: unknown) => {
  if (!isPlainRecord(raw)) return "apps";
  for (const [index, [id, plan]] of Object.entries(raw).entries()) {
    if (!isPlainRecord(plan) || !Object.hasOwn(plan, "id") || plan.id !== id) return `apps[${index}].id`;
    const issue = currentPlanIssue(plan);
    if (issue !== undefined) return `apps[${index}].${issue}`;
  }
  return undefined;
};

const checkedAppliedPayload = (check: (raw: unknown) => string | undefined) =>
  Schema.Unknown.check(
    Schema.makeFilter((raw) => {
      const issue = check(raw);
      return issue === undefined || `Invalid applied state v${APPLIED_STATE_VERSION} at ${issue}.`;
    }),
  );

const AppliedPlan = checkedAppliedPayload(currentPlanIssue).pipe(Schema.decodeTo(AppPlan));
const AppliedPlans = checkedAppliedPayload(currentMapIssue).pipe(
  Schema.decodeTo(Schema.Record(AppId, AppPlan)),
);

const requireMigrated = <A>(result: A | string, fromVersion: number): A => {
  if (typeof result === "string") {
    throw new AppliedStateMigrationError(
      `Cannot read applied state v${fromVersion} as v${APPLIED_STATE_VERSION}: ${result}.`,
    );
  }
  return result;
};

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
              return Effect.fail(unreadableAppliedStateError({ ...options, ...read, appId }));
            default: {
              const exhaustive: never = read;
              return exhaustive;
            }
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
          mapFailures((cause) => error("persist", cause)),
        ),
      removeAppliedPlan: (stateStore, appId) =>
        open(stateStore, appId).pipe(
          Effect.flatMap((bucket) => bucket.remove),
          mapFailures((cause) => error("remove", cause)),
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
            return Effect.fail(
              unreadableAppliedStateError({
                ...options,
                ...read,
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
        mapFailures((cause) => error("persist", cause)),
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
            default: {
              const exhaustive: never = read;
              return exhaustive;
            }
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
          bucket.mutate((current) => {
            if (current === null || !Object.hasOwn(current, appId)) {
              return Effect.succeed({ _tag: "Keep", result: undefined });
            }
            const { [appId]: _removed, ...remaining } = current;
            return Effect.succeed({ _tag: "Set", value: remaining, result: undefined });
          }),
        ),
        mapFailures((cause) => error("remove", cause)),
      ),
  };
}
