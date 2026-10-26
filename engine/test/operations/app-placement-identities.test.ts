import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppId, type AppPlan, ProviderId, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { infoApp } from "../../src/operations/info.ts";
import { logsApp } from "../../src/operations/logs.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { ensureAppPlacement, resolveAppPlacement } from "../../src/providers/app-placement.ts";
import {
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "../../src/providers/applied-state-resolution.ts";
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

test.each(["start", "info", "logs", "stop", "destroy"] as const)(
  "%s keeps a user app independent from a mount-cwd scratch realization",
  async (operation) => {
    const applied = [plan, scratch];
    const evidenceProviders = [
      { ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed(applied) },
    ];
    let mutations = 0;
    const harness = makeHarness({
      plannedApp: plan,
      appliedPlans: applied,
      resolveAppliedPlan: (root) => resolveAppliedPlanEvidence(root, evidenceProviders),
      resolveTeardownEvidence: (root) => resolveTeardownEvidence(root, evidenceProviders),
      onApply: () => mutations++,
      onDestroy: () => mutations++,
      onStop: () => mutations++,
    });
    try {
      const target = { app: user, root: plan.root, plan };
      const run = () => {
        switch (operation) {
          case "start":
            return Effect.runPromise(
              startApp({}, target).pipe(
                Effect.provide(harness.layer),
                Effect.map((result) => result.app),
              ),
            );
          case "info":
            return Effect.runPromise(
              withResolvedCwd(plan.root, infoApp()).pipe(
                Effect.provide(harness.layer),
                Effect.map((result) => result.app),
              ),
            );
          case "logs":
            return Effect.runPromise(
              withResolvedCwd(plan.root, logsApp()).pipe(
                Effect.provide(harness.layer),
                Effect.map((result) => result.app),
              ),
            );
          case "stop":
            return Effect.runPromise(
              stopApp({}, target).pipe(
                Effect.provide(harness.layer),
                Effect.map((result) => result.app),
              ),
            );
          case "destroy":
            return Effect.runPromise(
              destroyApp({}, target).pipe(
                Effect.provide(harness.layer),
                Effect.map((result) => result.app),
              ),
            );
        }
      };
      const result = await run();
      expect(result).toBe(plan.name);
      expect(mutations).toBe(operation === "info" || operation === "logs" ? 0 : 1);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test("scratch teardown evidence selects only its own colocated applied plan", async () => {
  const other = { ...scratch, id: AppId.make("scratch-other") };
  const providers = [
    { ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed([plan, scratch, other]) },
  ];
  const evidence = await Effect.runPromise(
    resolveTeardownEvidence(plan.root, providers, {
      kind: "scratch",
      id: scratchId,
    }),
  );
  expect(evidence).toEqual({ kind: "applied", plan: scratch });
});

test("scratch-only evidence is not observed or torn down as a user app", async () => {
  const providers = [{ ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed([scratch]) }];
  expect(await Effect.runPromise(resolveAppliedPlanEvidence(plan.root, providers))).toBeUndefined();
  expect(await Effect.runPromise(resolveTeardownEvidence(plan.root, providers))).toEqual({ kind: "absent" });
});

test("user cleanup evidence excludes colocated scratch inventory and orphan resources", async () => {
  const providers = [
    {
      ...TestRuntimeProvider,
      id: "lando",
      appliedPlans: Effect.succeed([scratch]),
      isAvailable: Effect.succeed(true),
      canCleanupOwnedResources: Effect.succeed(true),
      resourceOwnership: () =>
        Effect.succeed({
          appRoot: plan.root,
          ownerKey: appIdentityKey("owner", plan.root),
          providerId: plan.provider,
          appIds: [plan.id, scratch.id],
        }),
      list: () =>
        Effect.succeed([
          {
            app: scratch.id,
            appRoot: plan.root,
            service: ServiceName.make("web"),
            providerId: plan.provider,
            status: "running",
            publications: { status: "unknown" as const },
          },
        ]),
    },
  ];
  const evidence = await Effect.runPromise(resolveTeardownEvidence(plan.root, providers));
  expect(evidence).toEqual({
    kind: "owned",
    ownership: [
      {
        appRoot: plan.root,
        ownerKey: appIdentityKey("owner", plan.root),
        providerId: plan.provider,
        appIds: [plan.id],
      },
    ],
  });
});

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
