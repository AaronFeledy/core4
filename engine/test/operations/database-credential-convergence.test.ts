import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeLandoPaths } from "@lando/paths";
import { AppResolveError, ProviderUnavailableError, appliedStateVersionError } from "@lando/sdk/errors";
import {
  DatabaseCredentialConvergence,
  PathsService,
  RuntimeProviderRegistry,
  UserAppResolver,
} from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
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
