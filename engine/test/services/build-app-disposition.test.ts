import { expect, test } from "bun:test";
import { orDieWithRole } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, BuildStep } from "@lando/sdk/schema";
import { Effect, Exit, Schema } from "effect";
import { appStepDisposition, failedAppStepDisposition } from "../../src/services/build-app-disposition";
import type { AppBuildInput } from "../../src/services/build-app-step-runner.ts";
import type { AppBuildResult } from "../../src/services/build-results.ts";

const step = Schema.decodeUnknownSync(BuildStep)({
  id: "web:app:0",
  service: "web",
  phase: "app",
  kind: "execStream",
  dependsOn: [],
  buildKey: "test",
});

const appStep = { step, command: { command: ["build"] }, subject: "web" };

const input = {
  plan: {
    id: AppId.make("demo"),
    root: AbsolutePath.make("/tmp/demo"),
    name: "demo",
    slug: "demo",
    services: {},
    extensions: {},
  },
  redaction: {
    redactor: {
      redactString: (value: string) => value,
    },
  },
} as unknown as AppBuildInput;

test("a failed build step summarizes the typed error even when cleanup dies", () => {
  const primary = new ProviderUnavailableError({
    providerId: "test",
    operation: "execStream",
    message: "Build command unavailable.",
    remediation: "Restore the provider.",
  });
  const exit = Effect.runSyncExit(
    Effect.fail(primary).pipe(
      Effect.ensuring(Effect.die(new Error("release failed")).pipe(orDieWithRole("cleanup"))),
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected build failure");
  expect(failedAppStepDisposition(appStep, exit.cause, 7)).toEqual({
    outcome: "failed",
    summary: primary.message,
    durationMs: 7,
  });
});

test("a failed app step remediates with lando start, not rebuild", () => {
  // Given a ran app step that exited nonzero
  const transcriptPath = AbsolutePath.make("/tmp/build.log");
  // When disposition is computed
  const disposition = appStepDisposition(input, appStep, {
    _tag: "ran",
    attempt: { transcriptPath, containerId: "ctr-1" },
    result: { durationMs: 12, exitCode: 1 },
  });
  // Then remediation tells the user to run lando start again
  expect(disposition.outcome).toBe("failed");
  expect(disposition.failure?.remediation).toContain("then run lando start");
  expect(disposition.failure?.remediation).not.toContain("and rebuild");
  expect(disposition.failure?.remediation).toContain(String(transcriptPath));
});

test("a reused app step reports cached success without a failure", () => {
  // Given a prior success still eligible in the kept container (no new exec)
  const entry = {
    stepId: step.id,
    buildKey: step.buildKey,
    containerId: "ctr-kept",
    status: "succeeded",
  } as unknown as AppBuildResult;
  // When disposition is computed for reuse
  const disposition = appStepDisposition(input, appStep, { _tag: "reused", entry });
  // Then the step is succeeded/cached and carries no failure
  expect(disposition).toEqual({ outcome: "succeeded", summary: "web cached", durationMs: 0 });
  expect(disposition.failure).toBeUndefined();
});
