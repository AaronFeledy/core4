import { expect, test } from "bun:test";
import { Effect } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { stopAppWithPlan } from "../../src/operations/stop.ts";
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
    await Effect.runPromise(stopAppWithPlan({}, target).pipe(Effect.provide(harness.layer)));
  } else {
    await Effect.runPromise(destroyAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
  }

  expect(preparations).toBe(0);
  expect(mutations).toEqual(["destroy"]);
});
