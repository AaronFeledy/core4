import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  FileSyncSelectionError,
  LandofileParseError,
  LandofileValidationError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { type AppPlan, appIdentityKey } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { infoApp } from "../../src/operations/info.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const applied: AppPlan = {
  ...acceleratedPlan,
  identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
};
const unavailable = new ProviderUnavailableError({
  providerId: "docker",
  operation: "capabilities",
  message: "Desired provider is unavailable",
  remediation: "Start the desired provider.",
});
const selectionFailure = new FileSyncSelectionError({
  reason: "missing",
  candidates: [],
  message: "Desired file-sync engine is unavailable",
  remediation: "Install the desired file-sync engine.",
});
const parseFailure = new LandofileParseError({
  filePath: `${plan.root}/.lando.yml`,
  line: undefined,
  column: undefined,
  message: "Invalid desired YAML",
  remediation: "Correct the desired YAML.",
});
const configFailure = new LandofileValidationError({
  file: `${plan.root}/.lando.yml`,
  issues: [],
  message: "Invalid desired configuration",
  remediation: "Correct the desired configuration.",
});
const failures: readonly {
  readonly name: string;
  readonly failure:
    | ProviderUnavailableError
    | FileSyncSelectionError
    | LandofileParseError
    | LandofileValidationError;
  readonly capabilities?: typeof RuntimeProviderRegistry.Service.capabilities;
  readonly planning?: ReturnType<typeof AppPlanner.Service.plan>;
  readonly discover?: typeof LandofileService.Service.discover;
}[] = [
  { name: "provider capabilities", failure: unavailable, capabilities: Effect.fail(unavailable) },
  { name: "engine selection", failure: selectionFailure, planning: Effect.fail(selectionFailure) },
  { name: "Landofile parsing", failure: parseFailure, discover: Effect.fail(parseFailure) },
  { name: "config validation", failure: configFailure, discover: Effect.fail(configFailure) },
];

for (const scenario of failures) {
  for (const hasApplied of [true, false]) {
    test(`info ${hasApplied ? "retains applied info" : "fails strictly"} when desired ${scenario.name} fails`, async () => {
      // Given the same desired failure, with or without an applied realization.
      const harness = makeHarness({
        appliedPlans: hasApplied ? [applied] : [],
        resolveAppliedPlan: () => Effect.succeed(hasApplied ? applied : undefined),
      });
      const invocation = infoApp().pipe(
        Effect.provideService(
          AppPlanner,
          AppPlanner.of({
            plan: () => scenario.planning ?? Effect.succeed({ ...plan, valueModel: 1 as const }),
          }),
        ),
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          capabilities: scenario.capabilities ?? harness.runtimeProviderRegistry.capabilities,
        }),
      );
      try {
        // When observing through the ordinary info operation.
        const result = await Effect.runPromise(
          withResolvedCwd(
            plan.root,
            scenario.discover === undefined
              ? invocation
              : invocation.pipe(Effect.provideService(LandofileService, { discover: scenario.discover })),
          ).pipe(Effect.provide(harness.layer), Effect.result),
        );
        // Then failure is tolerated only when applied service and policy evidence exists.
        if (hasApplied) {
          const info = Result.getOrThrow(result);
          expect(info.services).toMatchObject([{ service: "web", provider: "lando", status: "running" }]);
          expect(info.fileSync).toMatchObject({
            applied: { mode: "accelerated", engineId: "mutagen" },
            pendingChange: false,
          });
          expect(info.fileSync).not.toHaveProperty("planned");
        } else {
          expect(result).toEqual(Result.fail(scenario.failure));
        }
      } finally {
        rmSync(harness.userDataRoot, { recursive: true, force: true });
      }
    });
  }
}

test("info retains a successful desired-versus-applied policy difference", async () => {
  // Given an applied accelerated plan and an ordinary desired plan.
  const harness = makeHarness({ appliedPlans: [applied], resolveAppliedPlan: () => Effect.succeed(applied) });
  try {
    // When observing without an explicit target.
    const result = await Effect.runPromise(
      withResolvedCwd(plan.root, infoApp()).pipe(Effect.provide(harness.layer)),
    );
    // Then the desired policy remains distinct from the applied policy.
    expect(result.fileSync).toMatchObject({
      planned: { mode: "ordinary" },
      applied: { mode: "accelerated", engineId: "mutagen" },
      pendingChange: true,
    });
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test("info propagates desired planning defects despite an applied realization", async () => {
  // Given an unexpected defect rather than a typed desired-plan failure.
  const harness = makeHarness({ appliedPlans: [applied], resolveAppliedPlan: () => Effect.succeed(applied) });
  const defect = new TypeError("broken desired planner");
  try {
    // When observing, then Effect.result must not turn the defect into absent policy.
    await expect(
      Effect.runPromise(
        withResolvedCwd(
          plan.root,
          infoApp().pipe(Effect.provideService(AppPlanner, { plan: () => Effect.die(defect) })),
        ).pipe(Effect.provide(harness.layer), Effect.result),
      ),
    ).rejects.toThrow(defect.message);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

for (const stage of ["target verification", "service inspection", "applied policy read"] as const) {
  test(`info still fails when ${stage} fails`, async () => {
    // Given an applied realization whose verification or observation fails.
    let reads = 0;
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: stage,
      message: "Applied provider failed",
      remediation: "Repair the applied provider.",
    });
    const harness = makeHarness({
      appliedPlans: [applied],
      resolveAppliedPlan: () => {
        reads += 1;
        return stage === "applied policy read" && reads > 1 ? Effect.fail(failure) : Effect.succeed(applied);
      },
      ...(stage === "service inspection" ? { inspect: () => Effect.fail(failure) } : {}),
    });
    try {
      // When desired planning also fails, only that failure may be tolerated.
      const result = await Effect.runPromise(
        withResolvedCwd(
          plan.root,
          infoApp().pipe(
            Effect.provideService(AppPlanner, { plan: () => Effect.fail(selectionFailure) }),
            Effect.provideService(RuntimeProviderRegistry, {
              ...harness.runtimeProviderRegistry,
              ...(stage === "target verification" ? { select: () => Effect.fail(failure) } : {}),
            }),
          ),
        ).pipe(Effect.provide(harness.layer), Effect.result),
      );
      // Then the exact applied-side failure remains visible.
      expect(result).toEqual(Result.fail(failure));
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}
