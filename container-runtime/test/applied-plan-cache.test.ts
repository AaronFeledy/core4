import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

import { makeAppliedPlanCache } from "../src/applied-plan-cache.ts";

const appId = AppId.make("app");

const appPlan = (name: string, services: ReadonlyArray<string>): AppPlan =>
  ({
    id: appId,
    name,
    slug: "app",
    services: Object.fromEntries(services.map((service) => [service, { name: service }])),
  }) as AppPlan;

const stateStore = (lockFails: boolean): PluginStateStore => ({
  open: () => Effect.die("unused"),
  withLock: (_key, body) =>
    lockFails
      ? Effect.fail(
          new StateStoreError({
            reason: "lock",
            operation: "withLock",
            remediation: "Retry after the concurrent app operation completes.",
          }),
        )
      : body,
});

describe("applied plan cache", () => {
  test("loads a plan once for two lookups", async () => {
    const stored = new Map<AppId, AppPlan>([[appId, appPlan("stored", ["db"])]]);
    let loads = 0;
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("docker"),
      providerName: "Docker",
      appliedPlanState: stateStore(false),
      load: (_state, id) =>
        Effect.sync(() => {
          loads += 1;
          return stored.get(id);
        }),
      persist: () => Effect.void,
      remove: () => Effect.void,
    });

    const first = await Effect.runPromise(cache.resolvePlan(appId));
    const second = await Effect.runPromise(cache.resolvePlan(appId));

    expect(first).toBe(second);
    expect(loads).toBe(1);
  });

  test("merges and persists the sanitized plan when reconcile is false", async () => {
    const stored = new Map<AppId, AppPlan>([[appId, appPlan("stored", ["db"])]]);
    const persisted: AppPlan[] = [];
    let loads = 0;
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("docker"),
      providerName: "Docker",
      appliedPlanState: stateStore(false),
      sanitizeAppliedPlan: (plan) => ({ ...plan, name: `sanitized:${plan.name}` }),
      load: (_state, id) =>
        Effect.sync(() => {
          loads += 1;
          return stored.get(id);
        }),
      persist: (_state, plan) =>
        Effect.sync(() => {
          persisted.push(plan);
          stored.set(plan.id, plan);
        }),
      remove: () => Effect.void,
    });

    await Effect.runPromise(cache.rememberPlan(appPlan("incoming", ["web"]), false));

    expect(loads).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.name).toBe("sanitized:incoming");
    expect(Object.keys(persisted[0]?.services ?? {}).sort()).toEqual(["db", "web"]);
  });

  test("skips the previous-plan load when reconcile is true", async () => {
    const stored = new Map<AppId, AppPlan>([[appId, appPlan("stored", ["db"])]]);
    const persisted: AppPlan[] = [];
    let loads = 0;
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("docker"),
      providerName: "Docker",
      appliedPlanState: stateStore(false),
      sanitizeAppliedPlan: (plan) => ({ ...plan, name: `sanitized:${plan.name}` }),
      load: () =>
        Effect.sync(() => {
          loads += 1;
          return stored.get(appId);
        }),
      persist: (_state, plan) =>
        Effect.sync(() => {
          persisted.push(plan);
        }),
      remove: () => Effect.void,
    });

    await Effect.runPromise(cache.rememberPlan(appPlan("incoming", ["web"]), true));

    expect(loads).toBe(0);
    expect(Object.keys(persisted[0]?.services ?? {})).toEqual(["web"]);
    expect(persisted[0]?.name).toBe("sanitized:incoming");
  });

  test("forgets a plan from the cache and from state", async () => {
    const stored = new Map<AppId, AppPlan>([[appId, appPlan("stored", ["db"])]]);
    const removed: AppId[] = [];
    let loads = 0;
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("docker"),
      providerName: "Docker",
      appliedPlanState: stateStore(false),
      load: (_state, id) =>
        Effect.sync(() => {
          loads += 1;
          return stored.get(id);
        }),
      persist: () => Effect.void,
      remove: (_state, id) =>
        Effect.sync(() => {
          removed.push(id);
          stored.delete(id);
        }),
    });

    await Effect.runPromise(cache.resolvePlan(appId));
    await Effect.runPromise(cache.forgetPlan(appId));
    const after = await Effect.runPromise(cache.resolvePlan(appId));

    expect(removed).toEqual([appId]);
    expect(after).toBeUndefined();
    expect(loads).toBe(2);
  });

  test("keeps plans in memory when no state store is configured", async () => {
    let loads = 0;
    let persists = 0;
    let removes = 0;
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("podman"),
      providerName: "provider-podman",
      load: () =>
        Effect.sync(() => {
          loads += 1;
          return undefined;
        }),
      persist: () =>
        Effect.sync(() => {
          persists += 1;
        }),
      remove: () =>
        Effect.sync(() => {
          removes += 1;
        }),
    });

    await Effect.runPromise(cache.rememberPlan(appPlan("memory", ["web"]), false));
    const cached = await Effect.runPromise(cache.resolvePlan(appId));
    await Effect.runPromise(cache.forgetPlan(appId));
    const forgotten = await Effect.runPromise(cache.resolvePlan(appId));

    expect(cached?.name).toBe("memory");
    expect(forgotten).toBeUndefined();
    expect(loads).toBe(0);
    expect(persists).toBe(0);
    expect(removes).toBe(0);
  });

  test("maps a lock failure to ProviderUnavailableError", async () => {
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("docker"),
      providerName: "Docker",
      appliedPlanState: stateStore(true),
      load: () => Effect.succeed(undefined),
      persist: () => Effect.void,
      remove: () => Effect.void,
    });

    const error = await Effect.runPromise(
      cache.rememberPlan(appPlan("incoming", ["web"]), true).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.operation).toBe("applied-state.lock");
    expect(error.message).toBe("Unable to lock Docker applied plan state.");
  });
});
