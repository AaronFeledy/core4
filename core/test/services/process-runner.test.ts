import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Queue, Stream } from "effect";

import { ProcessExecError, ProcessTimeoutError } from "@lando/core/errors";
import { EventService, ProcessRunner } from "@lando/core/services";
import { createRedactor } from "@lando/sdk/secrets";
import type { LandoEvent } from "@lando/sdk/services";
import { RedactionService } from "../../src/redaction/service.ts";
import { ProcessRunnerLive } from "../../src/services/process-runner.ts";

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

const captureEventsLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  } satisfies EventService.Service);

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

  test("redacts constructed ProcessExecError fields when RedactionService is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-process-topsecret-"));
    try {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ProcessRunner, (processRunner) =>
          processRunner.run({ cmd: "missing-topsecret-binary", args: [], cwd }),
        ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProcessExecError);
          expect(failure.value.message).toContain("[redacted]");
          expect(failure.value.message).not.toContain("topsecret");
          expect(failure.value.cmd).toBe("missing-[redacted]-binary");
          expect(failure.value.cwd).toContain("[redacted]");
          expect(failure.value.cwd).not.toContain("topsecret");
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
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

  test("redacts constructed ProcessTimeoutError fields when RedactionService is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-timeout-topsecret-"));
    const bunLink = join(cwd, "bun-topsecret");
    try {
      await symlink(process.execPath, bunLink);
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ProcessRunner, (processRunner) =>
          processRunner.run({
            cmd: bunLink,
            args: ["-e", "await new Promise(() => {})"],
            cwd,
            timeoutMs: 50,
          }),
        ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProcessTimeoutError);
          expect(failure.value.message).toContain("[redacted]");
          expect(failure.value.message).not.toContain("topsecret");
          expect(failure.value.cmd).toContain("[redacted]");
          expect(failure.value.cmd).not.toContain("topsecret");
          expect(failure.value.cwd).toContain("[redacted]");
          expect(failure.value.cwd).not.toContain("topsecret");
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not redact successful ProcessResult data", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({ cmd: "bun", args: ["-e", "console.log('topsecret')"] }),
      ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(result.stdout).not.toContain("[redacted]");
  });

  test("redacts successful pre/post process event payloads when RedactionService is present", async () => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({
          cmd: "bun",
          args: ["-e", "console.log(process.env.BUN_AUTH_TOKEN)"],
          env: { BUN_AUTH_TOKEN: "topsecret" },
        }),
      ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, redactionLayer, captureEventsLayer(events)))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(events.map((event) => event._tag)).toEqual(["pre-process-exec", "post-process-exec"]);
    const payload = JSON.stringify(events);
    expect(payload).not.toContain("topsecret");
    expect(payload).toContain("[redacted]");
  });

  test("does not publish process exec events without RedactionService", async () => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      Effect.flatMap(ProcessRunner, (processRunner) =>
        processRunner.run({
          cmd: "bun",
          args: ["-e", "console.log(process.env.BUN_AUTH_TOKEN)"],
          env: { BUN_AUTH_TOKEN: "topsecret" },
        }),
      ).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive, captureEventsLayer(events)))),
    );

    expect(result.stdout).toContain("topsecret");
    expect(events).toEqual([]);
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
