import { expect, test } from "bun:test";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { GlobalAppError } from "@lando/sdk/errors";
import { GlobalAppService } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { mergeFailure } from "../../src/lifecycle/failure-compensation.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

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
        root: Effect.succeed(plan.root),
        paths: Effect.die("unused"),
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
