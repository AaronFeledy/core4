import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

import { makeAppliedPlanCache } from "../src/applied-plan-cache.ts";
import { plan as valuePlan } from "./fixtures/environment-values.ts";

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
  test.each([false, true])(
    "refuses unreadable durable state before persisting reconcile=%s",
    async (reconcile) => {
      const error = new ProviderUnavailableError({
        providerId: "docker",
        operation: "applied-state.read",
        message: "Unreadable state",
        remediation: "Restore the file from backup.",
      });
      let readable = true;
      let writes = 0;
      const cache = makeAppliedPlanCache({
        providerId: ProviderId.make("docker"),
        providerName: "Docker",
        appliedPlanState: stateStore(false),
        load: () =>
          Effect.suspend(() => (readable ? Effect.succeed(appPlan("saved", ["db"])) : Effect.fail(error))),
        persist: () =>
          Effect.sync(() => {
            writes += 1;
          }),
        remove: () => Effect.void,
      });
      await Effect.runPromise(cache.resolvePlan(appId));
      readable = false;
      expect(
        await Effect.runPromise(
          cache.rememberPlan(appPlan("incoming", ["web"]), reconcile).pipe(Effect.flip),
        ),
      ).toBe(error);
      expect(writes).toBe(0);
      expect(await Effect.runPromise(cache.resolvePlan(appId))).toBeUndefined();
    },
  );
  test.each([false, true])(
    "projects hooks before memory caching with persistent state=%s",
    async (persistent) => {
      const desired: AppPlan = {
        ...valuePlan,
        events: { "pre-stop": [{ step: "stale", source: "project", sourceIndex: 0, status: "active" }] },
        extensions: { eventSites: ["stale"], retainedTooling: { task: "cleanup" } },
      };
      const written: AppPlan[] = [];
      let stored: AppPlan | undefined;
      const cache = makeAppliedPlanCache({
        providerId: desired.provider,
        providerName: "test",
        ...(persistent ? { appliedPlanState: stateStore(false) } : {}),
        sanitizeAppliedPlan: (input) => {
          const { eventSites: _sites, ...extensions } = input.extensions;
          return { ...input, extensions };
        },
        load: () => Effect.sync(() => stored),
        persist: (_state, input) =>
          Effect.sync(() => {
            written.push(input);
            stored = input;
          }),
        remove: () => Effect.void,
      });
      await Effect.runPromise(cache.rememberPlan(desired, true));
      const observed = await Effect.runPromise(cache.resolvePlan(desired.id));
      const { events: _events, ...record } = desired;
      const expected = { ...record, extensions: { retainedTooling: { task: "cleanup" } } };
      expect(observed).toEqual(expected);
      expect(written).toEqual(persistent ? [expected] : []);
      expect(desired.events?.["pre-stop"]).toHaveLength(1);
    },
  );
  test("reuses the cached plan for observation and reads fresh state for mutation", async () => {
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
    expect(second).toBe(first);
    expect(loads).toBe(1);

    await Effect.runPromise(cache.resolveMutationPlan(appId));
    expect(loads).toBe(2);
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

  test("verifies the previous plan even when reconcile is true", async () => {
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

    expect(loads).toBe(1);
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

  test("keeps the cached plan when state removal fails", async () => {
    let stored: AppPlan | undefined;
    const cache = makeAppliedPlanCache({
      providerId: ProviderId.make("podman"),
      providerName: "provider-podman",
      appliedPlanState: stateStore(false),
      load: () => Effect.sync(() => stored),
      persist: (_state, plan) =>
        Effect.sync(() => {
          stored = plan;
        }),
      remove: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "podman",
            operation: "applied-state.remove",
            message: "Removal failed.",
            remediation:
              "Install or start the `podman` provider and confirm it can perform `applied-state.remove`.",
          }),
        ),
    });

    await Effect.runPromise(cache.rememberPlan(appPlan("sticky", ["web"]), true));
    const failure = await Effect.runPromise(cache.forgetPlan(appId).pipe(Effect.flip));
    const stillCached = await Effect.runPromise(cache.resolvePlan(appId));

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(stillCached?.name).toBe("sticky");
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
