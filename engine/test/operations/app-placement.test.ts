import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppResolveError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  ensureAppPlacement,
  observedAppPlan,
  resolveAppPlacement,
} from "../../src/providers/app-placement.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const desired = { ...plan, provider: ProviderId.make("docker") };
const applied = {
  ...plan,
  provider: ProviderId.make("lando"),
  identity: { appRoot: plan.root, ownerKey: "owner" },
};
const app = { kind: "user" as const, id: desired.id, root: desired.root };
const target = { app, root: desired.root, plan: desired };

for (const operation of [startApp, rebuildApp, restartApp]) {
  test(`${operation.name} refuses another provider's applied app before apply or teardown`, async () => {
    let mutations = 0;
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: [applied],
      onApply: () => {
        mutations += 1;
      },
      onDestroy: () => {
        mutations += 1;
      },
      onStop: () => {
        mutations += 1;
      },
    });
    try {
      const result = await Effect.runPromise(
        operation({}, target).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AppPlacementError",
          app,
          desiredProviderId: "docker",
          realizedProviderId: "lando",
        },
      });
      expect(mutations).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}

test("observation reuses the applied plan instead of the newly selected provider", async () => {
  const harness = makeHarness({ plannedApp: desired, appliedPlans: [applied] });
  try {
    const result = await Effect.runPromise(observedAppPlan(desired).pipe(Effect.provide(harness.layer)));
    expect(result).toEqual(applied);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test("ambiguous placement names provider-scoped confirmed destroy commands", async () => {
  const harness = makeHarness({ appliedPlans: [applied, { ...applied, provider: desired.provider }] });
  try {
    const error = await Effect.runPromise(
      resolveAppPlacement(app, desired.provider).pipe(Effect.provide(harness.layer), Effect.flip),
    );
    expect(error).toBeInstanceOf(AppResolveError);
    if (!(error instanceof AppResolveError)) throw error;
    expect(error.remediation).toContain("lando destroy --provider=lando --yes");
    expect(error.remediation).toContain("lando destroy --provider=docker --yes");
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test("an app on its existing provider may reconcile", async () => {
  const harness = makeHarness({ appliedPlans: [applied] });
  try {
    const result = await Effect.runPromise(
      ensureAppPlacement(app, applied.provider).pipe(Effect.provide(harness.layer)),
    );
    expect(result).toBe(applied.provider);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});
