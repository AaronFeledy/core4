import { expect, test } from "bun:test";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { GlobalAppError, ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { mergeFailure } from "../../src/lifecycle/failure-compensation.ts";
import { withIncompleteStartNotice } from "../../src/operations/start-incomplete-notice.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { recoveryHarness, target } from "./accelerated-start-recovery-support.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("a failed user start preserves the primary tag without rollback-role errors", async () => {
  const primary = new ServiceStartError({
    service: "web",
    providerId: "lando",
    operation: "apply",
    message: "dependency gate failed",
    remediation: "Repair the dependency and retry start.",
  });
  let destroyed = 0;
  const harness = makeHarness({
    apply: () => Effect.fail(primary),
    onDestroy: () => {
      destroyed++;
    },
    destroyEffect: Effect.fail(
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "destroy",
        message: "must not run",
        remediation: "Install or start the `lando` provider and confirm it can perform `destroy`.",
      }),
    ),
  });
  const exit = await Effect.runPromiseExit(
    startAppForTarget(
      {},
      {
        plan,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.error).toBe(primary);
    expect(outcome.additionalErrors).toEqual([]);
  }
  expect(destroyed).toBe(0);
});

// Placement reads the global paths before any global mutation, so the stub returns real paths.
const globalPaths = {
  root: AbsolutePath.make("/tmp/start-failure-roles/global"),
  distLandofile: AbsolutePath.make("/tmp/start-failure-roles/global/.lando.dist.yml"),
  userLandofile: AbsolutePath.make("/tmp/start-failure-roles/global/.lando.yml"),
};

test("startForTarget global error mapping preserves secondary roles and reasons", async () => {
  const primary = new GlobalAppError({ message: "global start", remediation: "repair" });
  const rollback = new GlobalAppError({ message: "global rollback", remediation: "undo" });
  const cause = mergeFailure(Cause.fail(primary), Cause.fail(rollback), "rollback");
  const harness = makeHarness();
  const plannedApp = { ...plan, requires: { globalServices: ["traefik"] } };
  const exit = await Effect.runPromiseExit(
    startAppForTarget(
      {},
      {
        plan: plannedApp,
        root: plan.root,
        app: { kind: "user", id: plan.id, root: plan.root },
      },
    ).pipe(
      Effect.provideService(GlobalAppService, {
        id: "global",
        providerId: Effect.succeed(plan.provider),
        root: Effect.succeed(plan.root),
        paths: Effect.succeed(globalPaths),
        ensureRoot: Effect.failCause(cause),
        ensureUserLandofile: Effect.die("unused"),
        regenerateDist: () => Effect.die("unused"),
        ensureRunning: () => Effect.die("unused"),
      }),
      Effect.provide(harness.layer),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: { _tag: "GlobalAutoStartError", cause: primary },
      additionalErrors: [{ role: "rollback", error: { _tag: "GlobalAutoStartError", cause: rollback } }],
    });
});

const noticeTarget = {
  plan,
  root: plan.root,
  app: { kind: "user" as const, id: plan.id, root: plan.root },
};

test("a pending resume preparation failure records the mutated-case notice", async () => {
  const warnings = makeCommandWarnings(false);
  const preparedTargets: string[] = [];
  const harness = await Effect.runPromise(
    recoveryHarness({
      phase: "preparing",
      harnessOptions: {
        providerCanPrepareFileSync: false,
        appliedFileSyncState: "missing",
        providerOverrides: {
          prepareFileSyncTargets: () =>
            Effect.sync(() => {
              preparedTargets.push("first-target");
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderUnavailableError({
                    providerId: "lando",
                    operation: "prepareFileSyncTargets",
                    message: "second target preparation failed",
                    remediation:
                      "Install or start the `lando` provider and confirm it can perform `prepareFileSyncTargets`.",
                  }),
                ),
              ),
            ),
        },
      },
    }),
  );
  const exit = await Effect.runPromiseExit(
    withIncompleteStartNotice(startAppForTarget({}, target)).pipe(
      Effect.provideService(CommandWarnings, warnings),
      Effect.provide(harness.layer),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(preparedTargets).toEqual(["first-target"]);
  const notices = await Effect.runPromise(warnings.failureNotices);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("Resources were left in place.");
  expect(notices[0]).not.toContain("No app resources changed");
});

test("a provider apply failure records the left-in-place inventory notice", async () => {
  // Given: a start whose provider apply fails after the attempt began changing the app.
  const warnings = makeCommandWarnings(false);
  const harness = makeHarness({
    apply: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "apply",
          message: "down",
          remediation: "Install or start the `lando` provider and confirm it can perform `apply`.",
        }),
      ),
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId: plan.provider,
        status: "running",
        publications: { status: "unknown" },
        containerId: "web-id",
      }),
  });
  // When: the start fails under the CLI notice wrapper.
  const exit = await Effect.runPromiseExit(
    withIncompleteStartNotice(startAppForTarget({}, noticeTarget)).pipe(
      Effect.provideService(CommandWarnings, warnings),
      Effect.provide(harness.layer),
    ),
  );
  // Then: one notice lists the retained running service.
  expect(Exit.isFailure(exit)).toBe(true);
  const notices = await Effect.runPromise(warnings.failureNotices);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("Resources were left in place. Running: web;");
});

test("a failure before any app mutation records the no-change notice", async () => {
  // Given: global auto-start fails before any app-owned acquisition or provider apply.
  const warnings = makeCommandWarnings(false);
  const harness = makeHarness();
  const plannedApp = { ...plan, requires: { globalServices: ["traefik"] } };
  // When: the start fails under the CLI notice wrapper.
  const exit = await Effect.runPromiseExit(
    withIncompleteStartNotice(startAppForTarget({}, { ...noticeTarget, plan: plannedApp })).pipe(
      Effect.provideService(GlobalAppService, {
        id: "global",
        providerId: Effect.succeed(plan.provider),
        root: Effect.succeed(plan.root),
        paths: Effect.succeed(globalPaths),
        ensureRoot: Effect.fail(new GlobalAppError({ message: "global start", remediation: "repair" })),
        ensureUserLandofile: Effect.die("unused"),
        regenerateDist: () => Effect.die("unused"),
        ensureRunning: () => Effect.die("unused"),
      }),
      Effect.provideService(CommandWarnings, warnings),
      Effect.provide(harness.layer),
    ),
  );
  // Then: the notice says nothing in the app changed.
  expect(Exit.isFailure(exit)).toBe(true);
  expect(await Effect.runPromise(warnings.failureNotices)).toEqual([
    "Start did not complete. No app resources changed. Fix the reported error, then run `lando start`.",
  ]);
});
