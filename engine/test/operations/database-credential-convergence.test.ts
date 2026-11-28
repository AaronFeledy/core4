import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeLandoPaths } from "@lando/paths";
import {
  AppPlacementError,
  AppResolveError,
  ProviderUnavailableError,
  appliedStateVersionError,
} from "@lando/sdk/errors";
import type { EngineIdentity } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import {
  DatabaseCredentialConvergence,
  PathsService,
  RuntimeProviderRegistry,
  UserAppResolver,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { layer } from "../../src/operations/database-credential-convergence.ts";
import { identityPlan, identityTarget } from "./data-identity-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each(["newer discovery", "unreadable discovery", "newer slot", "mismatch", "absent"] as const)(
  "credential convergence distinguishes %s from other placement outcomes",
  async (scenario) => {
    const plan = identityPlan("db-app");
    const { landofile } = identityTarget(plan);
    if (landofile === undefined) throw new Error("Expected the fixture Landofile");
    const newer = appliedStateVersionError({
      providerId: plan.provider,
      appId: plan.id,
      operation: "applied-state.read",
      path: "/state/db-app.json",
      storedVersion: 12,
      supportedVersion: 11,
      scope: "app",
    });
    const damaged = new ProviderUnavailableError({
      providerId: plan.provider,
      operation: "applied-state.read",
      message: "Cannot read applied state.",
      remediation: "Restore the applied state file from a backup.",
    });
    const mismatch = new AppResolveError({
      reason: "mismatch",
      detail: "provider-resources",
      message: "Runtime ownership disagrees.",
      remediation: "Resolve the conflicting app placement.",
    });
    const registry = makeTestRuntimeProviderRegistry({
      resolveAppliedPlan: () => {
        switch (scenario) {
          case "newer discovery":
            return Effect.fail(newer);
          case "unreadable discovery":
            return Effect.fail(damaged);
          case "mismatch":
            return Effect.fail(mismatch);
          case "newer slot":
            return Effect.succeed(plan);
          case "absent":
            return Effect.succeed(undefined);
          default:
            return scenario satisfies never;
        }
      },
      readAppliedPlanStrict: () => Effect.fail(newer),
      select: () => Effect.die("Should not select a runtime without a readable applied plan"),
    });
    const harness = makeHarness({ plannedApp: plan });
    try {
      const dependencies = Layer.mergeAll(
        harness.layer,
        Layer.succeed(RuntimeProviderRegistry, registry),
        Layer.succeed(UserAppResolver, {
          current: Effect.succeed(landofile),
          load: () => Effect.succeed(landofile),
        }),
        Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: harness.userDataRoot })),
      );
      const failure = await Effect.runPromise(
        Effect.flatMap(DatabaseCredentialConvergence, (service) =>
          service.reconcile({ root: plan.root, apply: true }),
        ).pipe(Effect.flip, Effect.provide(layer.pipe(Layer.provide(dependencies)))),
      );
      switch (scenario) {
        case "newer discovery":
        case "newer slot":
          expect(failure).toBe(newer);
          break;
        case "unreadable discovery":
          expect(failure).toBe(damaged);
          break;
        case "mismatch":
          expect(failure).toMatchObject({ _tag: "SqlCredentialTargetError", reason: "target-changed" });
          break;
        case "absent":
          expect(failure).toMatchObject({ _tag: "SqlCredentialTargetError", reason: "not-running" });
          break;
        default:
          return scenario satisfies never;
      }
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

const engine = (host: string): EngineIdentity => ({
  fingerprint: host,
  endpoint: `unix:///${host}/podman.sock`,
});

const engineIdentityRun = async (current?: EngineIdentity) => {
  const plan = identityPlan("db-app");
  const { landofile } = identityTarget(plan);
  if (landofile === undefined) throw new Error("Expected the fixture Landofile");
  const recorded = { ...plan, engineIdentity: engine("first") };
  const calls: string[] = [];
  const provider = new Proxy<RuntimeProviderShape>(
    {
      ...TestRuntimeProvider,
      id: String(plan.provider),
      ...(current === undefined ? {} : { engineIdentity: current }),
    },
    {
      get(source, property, receiver) {
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function"
          ? (...args: ReadonlyArray<unknown>) => {
              calls.push(String(property));
              return (value as (...inner: ReadonlyArray<unknown>) => unknown).apply(source, [...args]);
            }
          : value;
      },
    },
  );
  const registry = makeTestRuntimeProviderRegistry({
    resolveAppliedPlan: () => Effect.succeed(recorded),
    readAppliedPlanStrict: () => Effect.succeed(recorded),
    select: () => Effect.succeed(provider),
  });
  const harness = makeHarness({ plannedApp: plan });
  try {
    const dependencies = Layer.mergeAll(
      harness.layer,
      Layer.succeed(RuntimeProviderRegistry, registry),
      Layer.succeed(UserAppResolver, {
        current: Effect.succeed(landofile),
        load: () => Effect.succeed(landofile),
      }),
      Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: harness.userDataRoot })),
    );
    const outcome = await Effect.runPromise(
      Effect.flatMap(DatabaseCredentialConvergence, (service) =>
        service.reconcile({ root: plan.root, apply: true }),
      ).pipe(Effect.result, Effect.provide(layer.pipe(Layer.provide(dependencies)))),
    );
    return { outcome, calls };
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
};

test("credential convergence refuses a record from another engine before inspecting it", async () => {
  const { outcome, calls } = await engineIdentityRun(engine("second"));

  if (outcome._tag !== "Failure") throw new Error("expected credential convergence to refuse");
  expect(outcome.failure).toBeInstanceOf(AppPlacementError);
  if (outcome.failure instanceof AppPlacementError) {
    expect(outcome.failure.message).toContain(engine("first").endpoint);
    expect(outcome.failure.message).toContain(engine("second").endpoint);
  }
  expect(calls).toEqual([]);
});

test("credential convergence proceeds when the provider has no engine identity", async () => {
  const { outcome } = await engineIdentityRun(undefined);

  if (outcome._tag === "Failure" && outcome.failure instanceof AppPlacementError)
    throw new Error("a missing identity must not refuse placement");
});
