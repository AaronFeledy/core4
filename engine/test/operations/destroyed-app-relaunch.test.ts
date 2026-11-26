import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type AppPlan, appIdentityKey } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";

import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { resolveAppliedPlanEvidence } from "../../src/providers/applied-state-resolution.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

// A plain destroy removes the containers and the applied plan; its ownership record keeps the data volume.
const destroyed = {
  ...TestRuntimeProvider,
  id: String(plan.provider),
  appliedPlans: Effect.succeed([]),
  list: () => Effect.succeed([]),
  listVolumes: () => Effect.succeed([]),
  resourceOwnership: () =>
    Effect.succeed({
      appRoot: plan.root,
      ownerKey: appIdentityKey("owner", plan.root),
      providerId: plan.provider,
      appIds: [plan.id],
      members: [
        { kind: "volume" as const, nativeName: "lando-test-start--web--storage--data", appId: plan.id },
      ],
    }),
};

test.each([
  { name: "restart", run: (target: ResolvedAppTarget) => Effect.asVoid(restartApp({}, target)) },
  { name: "rebuild", run: (target: ResolvedAppTarget) => Effect.asVoid(rebuildApp({}, target)) },
])("bare $name starts an app a plain destroy left with its data volumes", async ({ run }) => {
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    appliedPlans: [],
    resolveAppliedPlan: (root, app, lookup) => resolveAppliedPlanEvidence(root, [destroyed], app, lookup),
    onApply: (next) => {
      applied.push(next);
    },
  });
  try {
    await Effect.runPromise(
      run({
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
        landofile: literalTestLandofile({ name: plan.name, services: {} }, plan.root),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(applied.map((next) => next.id)).toEqual([plan.id]);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});
