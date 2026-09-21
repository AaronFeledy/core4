import { readdir } from "node:fs/promises";

import { Effect, Option, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, AppPlan, type AppPlan as AppPlanShape } from "@lando/sdk/schema";

const APPLIED_STATE_VERSION = 1;
const APPLIED_PLAN_NAMESPACE = "applied-plans";
const APPLIED_PLANS_KEY = "applied-plans.json";
const AppliedPlans = Schema.Record({ key: AppId, value: AppPlan });

export const appliedPlansDir = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/${APPLIED_PLAN_NAMESPACE}`;

export const appliedPlanPath = (stateDir: string, appId: AppId): string =>
  `${appliedPlansDir(stateDir)}/${appId}.json`;

interface AppliedPlanOperations {
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
  readonly listAppliedPlans: (
    stateStore: PluginStateStore,
    stateDir: string,
  ) => Effect.Effect<ReadonlyArray<AppPlanShape>, ProviderUnavailableError>;
}

export interface RecordAppliedPlanStore extends AppliedPlanOperations {
  readonly listAppliedPlans: (
    stateStore: PluginStateStore,
  ) => Effect.Effect<ReadonlyArray<AppPlanShape>, ProviderUnavailableError>;
}

interface AppliedPlanStoreOptions {
  readonly providerId: "docker" | "lando" | "podman";
  readonly layout: "per-app" | "record";
}

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

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
        onCorrupt: "discard",
        onVersionMismatch: "discard",
      });
    const loadForList = (stateStore: PluginStateStore, appId: AppId) =>
      open(stateStore, appId).pipe(
        Effect.flatMap((bucket) => bucket.get),
        Effect.map((plan) => plan ?? undefined),
        Effect.mapError((cause) => error("list", cause)),
      );
    return {
      persistAppliedPlan: (stateStore, plan) =>
        open(stateStore, plan.id).pipe(
          Effect.flatMap((bucket) => bucket.set(plan).pipe(Effect.as(bucket.path))),
          Effect.mapError((cause) => error("persist", cause)),
        ),
      loadAppliedPlan: (stateStore, appId) =>
        open(stateStore, appId).pipe(
          Effect.flatMap((bucket) => bucket.get),
          Effect.map((plan) => plan ?? undefined),
          Effect.catchAll(() => Effect.succeed(undefined)),
        ),
      removeAppliedPlan: (stateStore, appId) =>
        open(stateStore, appId).pipe(
          Effect.flatMap((bucket) => bucket.remove),
          Effect.mapError((cause) => error("remove", cause)),
        ),
      listAppliedPlans: (stateStore, stateDir) =>
        Effect.tryPromise({ try: () => readdir(appliedPlansDir(stateDir)), catch: (cause) => cause }).pipe(
          Effect.catchIf(isMissing, () => Effect.succeed([])),
          Effect.mapError((cause) => error("list", cause)),
          Effect.map((entries) =>
            entries.flatMap((entry) => {
              if (!entry.endsWith(".json")) return [];
              return Option.match(Schema.decodeUnknownOption(AppId)(entry.slice(0, -5)), {
                onNone: () => [],
                onSome: (appId) => [appId],
              });
            }),
          ),
          Effect.flatMap((ids) => Effect.forEach(ids, (id) => loadForList(stateStore, id))),
          Effect.map((plans) => plans.filter((plan): plan is AppPlanShape => plan !== undefined)),
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
      onCorrupt: "discard",
      onVersionMismatch: "discard",
      default: {},
    });
  return {
    persistAppliedPlan: (stateStore, plan) =>
      open(stateStore).pipe(
        Effect.flatMap((bucket) =>
          bucket.modify((current) => [bucket.path, { ...(current ?? {}), [plan.id]: plan }]),
        ),
        Effect.mapError((cause) => error("persist", cause)),
      ),
    loadAppliedPlan: (stateStore, appId) =>
      open(stateStore).pipe(
        Effect.flatMap((bucket) => bucket.get),
        Effect.map((plans) => plans?.[appId]),
        Effect.catchAll(() => Effect.succeed(undefined)),
      ),
    listAppliedPlans: (stateStore: PluginStateStore) =>
      open(stateStore).pipe(
        Effect.flatMap((bucket) => bucket.get),
        Effect.map((plans) => Object.values(plans ?? {})),
        Effect.mapError((cause) => error("list", cause)),
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
