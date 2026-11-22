import { expect, test } from "bun:test";
import { orDieWithRole } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { BuildStep } from "@lando/sdk/schema";
import { Effect, Exit, Schema } from "effect";
import { failedAppStepDisposition } from "../../src/services/build-app-disposition";

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
  const step = Schema.decodeUnknownSync(BuildStep)({
    id: "web:app:0",
    service: "web",
    phase: "app",
    kind: "execStream",
    dependsOn: [],
    buildKey: "test",
  });
  expect(failedAppStepDisposition({ step, command: { command: ["build"] } }, exit.cause, 7)).toEqual({
    outcome: "failed",
    summary: primary.message,
    durationMs: 7,
  });
});
