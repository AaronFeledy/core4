import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";

import { ProcessExecError, ProcessTimeoutError } from "@lando/core/errors";
import { ProcessRunner } from "@lando/core/services";
import { ProcessRunnerLive } from "../../src/services/process-runner.ts";

const runProcess = (input: Parameters<ProcessRunner.Service["run"]>[0]) =>
  Effect.runPromise(
    Effect.flatMap(ProcessRunner, (processRunner) => processRunner.run(input)).pipe(
      Effect.provide(ProcessRunnerLive),
    ),
  );

describe("ProcessRunnerLive", () => {
  test("runs a command and captures stdout", async () => {
    const result = await runProcess({ cmd: "echo", args: ["hello"] });

    expect(result).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
  });

  test("returns non-zero exit as data", async () => {
    const result = await runProcess({ cmd: "false", args: [] });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("fails with ProcessExecError when executable is missing", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({ cmd: "definitely-not-a-binary", args: [] }),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProcessExecError);
        expect(failure.value.cmd).toBe("definitely-not-a-binary");
        expect(failure.value.errno).toBeDefined();
      }
    }
  });

  test("timeout fails with ProcessTimeoutError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({ cmd: "bun", args: ["-e", "await new Promise(() => {})"], timeoutMs: 50 }),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProcessTimeoutError);
        expect(failure.value.elapsedMs).toBeGreaterThanOrEqual(50);
      }
    }
  });

  test("streams stdout and stderr chunks", async () => {
    const chunks = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner
          .stream({
            cmd: "bun",
            args: ["-e", "console.log('out'); console.error('err')"],
          })
          .pipe(Stream.runCollect),
      ).pipe(Effect.provide(ProcessRunnerLive)),
    );

    const decoded = Array.from(chunks).map((chunk) => ({
      kind: chunk.kind,
      text: new TextDecoder().decode(chunk.chunk),
    }));

    expect(decoded.some((chunk) => chunk.kind === "stdout" && chunk.text.includes("out"))).toBe(true);
    expect(decoded.some((chunk) => chunk.kind === "stderr" && chunk.text.includes("err"))).toBe(true);
  });
});
