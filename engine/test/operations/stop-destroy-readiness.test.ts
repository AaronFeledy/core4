import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AppPlan, appIdentityKey, landoCacheStoreName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { haltAppRuntime } from "../../src/operations/stop.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test.each(["stop", "destroy"] as const)("%s leaves runtime readiness untouched", async (operation) => {
  let preparations = 0;
  const mutations: string[] = [];
  const harness = makeHarness({
    providerOverrides: {
      ensureReady: Effect.sync(() => {
        preparations += 1;
      }),
    },
    onStop: () => mutations.push("stop"),
    onDestroy: () => mutations.push("destroy"),
  });
  const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

  if (operation === "stop") {
    await Effect.runPromise(haltAppRuntime(target).pipe(Effect.provide(harness.layer)));
  } else {
    await Effect.runPromise(destroyAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
  }

  expect(preparations).toBe(0);
  expect(mutations).toEqual(["destroy"]);
});

test.each(["stop", "destroy"] as const)("%s handles an idle owning runtime", async (operation) => {
  let preparations = 0;
  let running = false;
  const mutations: string[] = [];
  const harness = makeHarness({
    appliedPlans: [plan],
    providerOverrides: {
      getStatus: Effect.sync(() => ({ state: running ? ("running" as const) : ("idle" as const) })),
      ensureReady: Effect.sync(() => {
        preparations += 1;
        running = true;
      }),
    },
    onDestroy: () => {
      if (!running) throw new Error("destroy reached an idle runtime");
      mutations.push("destroy");
    },
  });
  const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
  const result =
    operation === "stop"
      ? (await Effect.runPromise(haltAppRuntime(target).pipe(Effect.provide(harness.layer)))).result
      : await Effect.runPromise(destroyAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
  expect(result.outcome).toBe(operation === "stop" ? "stopped" : "destroyed");
  expect(preparations).toBe(operation === "stop" ? 0 : 1);
  expect(mutations).toEqual(operation === "stop" ? [] : ["destroy"]);
});

test("idle stop uses the same status observation for coordination and provider action", async () => {
  let reads = 0;
  const mutations: string[] = [];
  const harness = makeHarness({
    appliedPlans: [plan],
    providerOverrides: {
      getStatus: Effect.sync(() => ({ state: ++reads === 1 ? ("idle" as const) : ("running" as const) })),
    },
    onDestroy: () => mutations.push("destroy"),
  });
  const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
  await Effect.runPromise(haltAppRuntime(target).pipe(Effect.provide(harness.layer)));
  expect(mutations).toEqual([]);
  expect(reads).toBe(1);
});

test("halt does not look up a retained global cache", async () => {
  const cache = landoCacheStoreName("composer");
  const applied: AppPlan = {
    ...plan,
    stores: [...plan.stores, { name: cache, scope: "global", kind: "cache" }],
  };
  const located: string[] = [];
  const harness = makeHarness({
    plannedApp: applied,
    appliedPlans: [applied],
    providerOverrides: {
      locateVolume: ({ store }) =>
        Effect.sync(() => {
          located.push(store);
          return { nativeName: store, coordinationKey: JSON.stringify(["endpoint:test", store]) };
        }),
    },
  });
  const target = {
    plan: applied,
    root: applied.root,
    app: { kind: "user" as const, id: applied.id, root: applied.root },
  };
  const result = await Effect.runPromise(haltAppRuntime(target).pipe(Effect.provide(harness.layer)));
  expect(result.result.outcome).toBe("stopped");
  expect(located).not.toContain(cache);
});

test("halt asks for this app's exact applied plan", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-halt-exact-")));
  try {
    const root = AbsolutePath.make(base);
    const desired = { ...plan, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } };
    const lookups: Array<string | undefined> = [];
    const harness = makeHarness({
      plannedApp: desired,
      resolveAppliedPlan: (_root, _app, lookup) => {
        lookups.push(lookup);
        return Effect.succeed(desired);
      },
    });
    const target = {
      plan: desired,
      root,
      app: { kind: "user" as const, id: desired.id, root },
      landofile: literalTestLandofile({ name: desired.name, services: {} }, root),
    };

    await Effect.runPromise(haltAppRuntime(target).pipe(Effect.provide(harness.layer)));

    expect(lookups.at(-1)).toBe("exact");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
