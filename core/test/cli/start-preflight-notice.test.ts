import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { CommandWarnings, makeCommandWarnings } from "@lando/engine/landofile/command-warnings";
import { ConfirmationPrompt } from "@lando/engine/operations/confirmation-prompt";
import { LandofileParseError } from "@lando/sdk/errors";
import { LandofileService } from "@lando/sdk/services";

import { rebuildSpec } from "../../src/cli/command-specs/app/rebuild";
import { restartSpec } from "../../src/cli/command-specs/app/restart";
import { startSpec } from "../../src/cli/command-specs/app/start";
import { type AppRuntimeServices, makeLandoRuntime } from "../../src/runtime/layer";

describe("start-like command preflight notices", () => {
  for (const spec of [startSpec, restartSpec, rebuildSpec]) {
    test.each(["text", "json", "yaml"])(`${spec.id} preserves refresh failure in %s mode`, async (format) => {
      // Given: cache refresh fails while loading the app, before any engine mutation.
      const failure = new LandofileParseError({
        message: "Invalid app file",
        filePath: "/app/.lando.yml",
        line: undefined,
        column: undefined,
      });
      const warnings = makeCommandWarnings(format !== "text");
      const runtime = Layer.mergeAll(
        makeLandoRuntime({ bootstrap: "app", telemetry: false }),
        Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.fail(failure) })),
      );
      const command: Effect.Effect<unknown, unknown, AppRuntimeServices> = spec.run({
        flags: { yes: true, format },
      });

      // When: the actual spec runs its refresh preflight with a command warning sink.
      const error = await Effect.runPromise(
        command.pipe(Effect.provideService(CommandWarnings, warnings), Effect.provide(runtime), Effect.flip),
      );
      const notices = await Effect.runPromise(warnings.failureNotices);

      // Then: the exact primary failure survives; only human output gets one no-mutation notice.
      expect(error).toBe(failure);
      expect(notices).toHaveLength(format === "text" ? 1 : 0);
      if (format === "text") expect(notices[0]).toContain("No app resources changed.");
    });
  }

  test("declining rebuild does not begin an attempt or record a notice", async () => {
    // Given: confirmation is declined and app discovery must not run.
    const warnings = makeCommandWarnings(false);
    const runtime = Layer.mergeAll(
      makeLandoRuntime({ bootstrap: "app", telemetry: false }),
      Layer.succeed(ConfirmationPrompt, { confirm: () => Effect.succeed("declined") }),
      Layer.succeed(LandofileService, { discover: Effect.die("Unexpected app discovery") }),
    );

    // When: rebuild is invoked without --yes.
    const result = await Effect.runPromise(
      rebuildSpec
        .run({ flags: {} })
        .pipe(Effect.provideService(CommandWarnings, warnings), Effect.provide(runtime), Effect.result),
    );

    // Then: confirmation, not start, fails and no incomplete-start notice is recorded.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CommandConfirmationError", reason: "declined" },
    });
    expect(await Effect.runPromise(warnings.failureNotices)).toEqual([]);
  });
});
