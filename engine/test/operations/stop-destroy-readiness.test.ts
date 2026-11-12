import { expect, test } from "bun:test";
import { Effect } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { haltAppRuntime } from "../../src/operations/stop.ts";
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
    await Effect.runPromise(haltAppRuntime({}, target).pipe(Effect.provide(harness.layer)));
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
      ? (await Effect.runPromise(haltAppRuntime({}, target).pipe(Effect.provide(harness.layer)))).result
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
  await Effect.runPromise(haltAppRuntime({}, target).pipe(Effect.provide(harness.layer)));
  expect(mutations).toEqual([]);
  expect(reads).toBe(1);
});
