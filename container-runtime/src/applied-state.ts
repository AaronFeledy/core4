import { readdir } from "node:fs/promises";

import { Effect, Option, Schema } from "effect";

import { ProviderUnavailableError, type StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, AppPlan, type AppPlan as AppPlanShape, type AppliedStateInventory } from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";
import type { StateBucket } from "@lando/sdk/services";

import {
  APPLIED_STATE_VERSION,
  migrateAppliedPlan,
  migrateAppliedPlansRecord,
} from "./applied-state-migrate.ts";

export {
  APPLIED_STATE_VERSION,
  migrateAppliedPlan,
  migrateAppliedPlansRecord,
} from "./applied-state-migrate.ts";

const APPLIED_PLAN_NAMESPACE = "applied-plans";
const APPLIED_PLANS_KEY = "applied-plans.json";
const AppliedPlans = Schema.Record(AppId, AppPlan);

export type AppliedPlanRead =
  | { readonly status: "missing" }
  | { readonly status: "readable"; readonly plan: AppPlanShape }
  | { readonly status: "unreadable"; readonly path: string };

export const unreadableAppliedStateError = (input: {
  readonly providerId: string;
  readonly path: string;
  readonly layout: "per-app" | "record";
}) =>
  new ProviderUnavailableError({
    providerId: input.providerId,
    operation: "applied-state.read",
    message: `The applied provider state file "${input.path}" is unreadable; refusing to mutate runtime resources.${input.layout === "record" ? " This file contains state for several apps; no app in this record can be safely mutated." : ""}`,
    remediation: `Restore "${input.path}" from backup; or, accepting that unflushed accelerated sync changes may be lost, move it aside and rerun \`lando destroy\`, which then cleans up by ownership labels.${input.layout === "record" ? " Moving this file aside affects every app in the record." : ""}`,
  });

const inspectBucket = <A>(bucket: StateBucket<A>) =>
  bucket.exists.pipe(
    Effect.flatMap((exists) =>
      exists
        ? bucket.get.pipe(Effect.map((value) => ({ exists: true, value })))
        : Effect.succeed({ exists: false, value: null }),
    ),
  );

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

export const appliedPlansDir = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/${APPLIED_PLAN_NAMESPACE}`;

export const appliedPlanPath = (stateDir: string, appId: AppId): string =>
  `${appliedPlansDir(stateDir)}/${appId}.json`;

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
      open(stateStore, appId).pipe(
        Effect.flatMap((bucket) =>
          inspectBucket(bucket).pipe(
            Effect.map(
              ({ exists, value }): AppliedPlanRead =>
                !exists
                  ? { status: "missing" }
                  : value === null
                    ? { status: "unreadable", path: bucket.path }
                    : { status: "readable", plan: value },
            ),
            Effect.catch(() => Effect.succeed<AppliedPlanRead>({ status: "unreadable", path: bucket.path })),
          ),
        ),
        Effect.catch((cause) =>
          Effect.succeed<AppliedPlanRead>({
            status: "unreadable",
            path: cause.path ?? `${APPLIED_PLAN_NAMESPACE}/${appId}.json`,
          }),
        ),
      );
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
      Effect.tryPromise({ try: () => readdir(appliedPlansDir(stateDir)), catch: (cause) => cause }).pipe(
        Effect.catchIf(
          (cause: unknown) => isErrnoCode(cause, "ENOENT"),
          () => Effect.succeed([]),
        ),
        Effect.mapError((cause) => error("list", cause)),
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            !entry.endsWith(".json")
              ? []
              : Option.match(Schema.decodeUnknownOption(AppId)(entry.slice(0, -5)), {
                  onNone: () => [],
                  onSome: (appId) => [appId],
                }),
          ),
        ),
        Effect.flatMap((ids) =>
          Effect.forEach(ids, (appId) =>
            inspectAppliedPlan(stateStore, appId).pipe(Effect.map((read) => ({ appId, read }))),
          ),
        ),
        Effect.map(
          (reads): AppliedStateInventory => ({
            plans: reads.flatMap(({ read }) => (read.status === "readable" ? [read.plan] : [])),
            unreadable: reads.flatMap(({ appId, read }) =>
              read.status === "unreadable" ? [{ appId, path: read.path }] : [],
            ),
          }),
        ),
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
    open(stateStore).pipe(
      Effect.flatMap((bucket) =>
        inspectBucket(bucket).pipe(
          Effect.map(({ exists, value }) =>
            exists && value === null
              ? { status: "unreadable" as const, path: bucket.path }
              : { status: "readable" as const, plans: value },
          ),
          Effect.catch(() => Effect.succeed({ status: "unreadable" as const, path: bucket.path })),
        ),
      ),
      Effect.catch((cause: StateStoreError) =>
        Effect.succeed({ status: "unreadable" as const, path: cause.path ?? APPLIED_PLANS_KEY }),
      ),
    );
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
