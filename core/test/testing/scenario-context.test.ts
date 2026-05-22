import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Cause, Effect } from "effect";

import { NotImplementedError } from "@lando/core/errors";
import { ScenarioContext, withScenarioContext } from "@lando/core/testing";

describe("withScenarioContext", () => {
  test("provides a scoped ScenarioContext and removes testDir after success", async () => {
    let cleanupSawTestDir = false;
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "happy-path" }, (context) =>
        Effect.gen(function* () {
          const provided = yield* ScenarioContext;
          expect(provided).toBe(context);
          expect(context.guideId).toBe("node-postgres");
          expect(context.scenarioId).toBe("happy-path");
          expect(context.variant).toEqual({});
          expect(existsSync(context.testDir)).toBe(true);

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleanupSawTestDir = existsSync(context.testDir);
            }),
          );
          yield* context.transcript.append({ kind: "note", data: "before run" });
          const run = yield* context.runCli(["version"]);

          return {
            testDir: context.testDir,
            run,
            transcriptFrames: context.transcript.frames,
            processRunnerCalls: context.runtime.calls.processRunner.length,
          };
        }),
      ),
    );

    expect(result.run.exitCode).toBe(0);
    expect(result.run.stdout).toContain("0.0.0");
    expect(result.run.command).toEqual(["version"]);
    expect(result.transcriptFrames).toHaveLength(2);
    expect(result.processRunnerCalls).toBe(0);
    expect(cleanupSawTestDir).toBe(true);
    expect(existsSync(result.testDir)).toBe(false);
  });

  test("preserves testDir when KEEP_SCENARIO_DIRS=1", async () => {
    const previous = process.env.KEEP_SCENARIO_DIRS;
    process.env.KEEP_SCENARIO_DIRS = "1";
    let testDir = "";

    try {
      testDir = await Effect.runPromise(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "kept" }, (context) =>
          Effect.succeed(context.testDir),
        ),
      );
      expect(existsSync(testDir)).toBe(true);
    } finally {
      if (previous === undefined) {
        process.env.KEEP_SCENARIO_DIRS = undefined;
      } else {
        process.env.KEEP_SCENARIO_DIRS = previous;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("shell runner fails with Alpha 2 remediation", async () => {
    const exit = await Effect.runPromiseExit(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "shell" }, (context) =>
        context.shell("echo hi"),
      ),
    );
    expect(exit._tag).toBe("Failure");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    const error = failure._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error instanceof NotImplementedError ? error.commandId : undefined).toBe("guide.run.shell");
    expect(error instanceof NotImplementedError ? error.remediation : undefined).toContain("Phase 3 Beta");
  });
});
