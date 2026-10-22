import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppId, type AppPlan, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import { destroyApp } from "../../src/operations/destroy.ts";
import { startApp } from "../../src/operations/start.ts";
import { ensureAppPlacement, resolveAppPlacement } from "../../src/providers/app-placement.ts";
import { plan as basePlan, makeHarness } from "./start-progress-topology-support.ts";

const plan: AppPlan = {
  ...basePlan,
  identity: { appRoot: basePlan.root, ownerKey: appIdentityKey("owner", basePlan.root) },
};
const user = { kind: "user" as const, id: plan.id, root: plan.root };
const scratchId = "scratch-placement-test";
const scratch: AppPlan = {
  ...plan,
  id: AppId.make(scratchId),
  extensions: { "@lando/core/scratch": { id: scratchId } },
};

test.each(["start", "destroy"] as const)(
  "%s keeps a user app independent from a mount-cwd scratch realization",
  async (operation) => {
    const applied = [plan, scratch];
    let mutations = 0;
    const harness = makeHarness({
      plannedApp: plan,
      appliedPlans: applied,
      onApply: () => mutations++,
      onDestroy: () => mutations++,
    });
    try {
      const target = { app: user, root: plan.root, plan };
      const result = await (operation === "start"
        ? Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)))
        : Effect.runPromise(destroyApp({}, target).pipe(Effect.provide(harness.layer))));
      expect(result.app).toBe(plan.name);
      expect(mutations).toBeGreaterThan(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test("scratch placement refuses another provider holding the same scratch identity", async () => {
  const realized = { ...scratch, provider: ProviderId.make("docker") };
  const harness = makeHarness({ appliedPlans: [plan, realized] });
  try {
    const result = await Effect.runPromise(
      ensureAppPlacement({ kind: "scratch", id: scratchId, root: scratch.root }, plan.provider).pipe(
        Effect.provide(harness.layer),
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AppPlacementError", realizedProviderId: "docker" },
    });
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test("two applied plans for one app identity on the same provider remain ambiguous", async () => {
  const harness = makeHarness({ appliedPlans: [plan, { ...plan }] });
  try {
    const result = await Effect.runPromise(
      resolveAppPlacement(user, plan.provider).pipe(Effect.provide(harness.layer), Effect.result),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AppResolveError", reason: "ambiguous" },
    });
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});
