import { expect, test } from "bun:test";
import * as Events from "@lando/engine/services/event-service";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import { PluginPackageOperationError } from "@lando/sdk/errors";
import { EventService, ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { ChildOutput, makeChildOutputPolicy } from "../../src/cli/child-output.ts";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { MetaBunResultSchema, metaBun, metaX } from "../../src/cli/commands/bun.ts";
import { redactPluginPackageError } from "../../src/cli/commands/plugin-package-error.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { processRunnerFor } from "../_support/process-runner.ts";

test.each(["json", "yaml"] as const)("%s keeps child channels in one result envelope", async (format) => {
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await runWithRendererHandling(
    metaBun({
      argv: ["-e", 'process.stdout.write("hello"); process.stderr.write("warning"); process.exit(7)'],
    }),
    {
      runtime: BunProcessRunner.layer,
      rendererMode: "plain",
      resultFormat: format,
      command: "meta:bun",
      resultSchema: MetaBunResultSchema,
      io,
      completion: (result) => commandCompletionFromExitCode(result.exitCode),
      setExitCode: (code) => codes.push(code),
      formatError: () => "unexpected failure",
    },
  );
  const envelope: unknown = format === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout());
  expect(envelope).toMatchObject({
    ok: false,
    result: { exitCode: 7 },
    output: {
      chunks: [
        { _tag: "stdout", chunk: "hello" },
        { _tag: "stderr", chunk: "warning" },
      ],
      truncated: false,
    },
  });
  expect(codes).toEqual([7]);
  expect(io.stderr()).toBe("");
});

test("machine X has no stdout banner and preserves its stdin descriptor", async () => {
  const io = createBufferedRendererIO();
  const requests: ProcessSpawnOptions[] = [];
  const runner = processRunnerFor((request) =>
    Effect.sync(() => {
      requests.push(request);
      return { exitCode: 0, stdout: "package output" };
    }),
  );
  await runWithRendererHandling(metaX({ spec: "fixture", argv: [] }), {
    runtime: Layer.succeed(ProcessRunner, runner),
    rendererMode: "plain",
    resultFormat: "json",
    command: "meta:x",
    resultSchema: (await import("../../src/cli/commands/bun.ts")).MetaXResultSchema,
    io,
    setExitCode: () => {},
    formatError: () => "unexpected failure",
  });
  expect(JSON.parse(io.stdout())).toMatchObject({
    result: { spec: "fixture", exitCode: 0 },
    output: { chunks: [{ _tag: "stdout", chunk: "package output" }] },
  });
  expect(requests[0]).toMatchObject({ capture: true, inheritStdin: true });
  expect(requests[0]?.inheritOutput).toBeUndefined();
});

test.each(["stdout", "stderr"] as const)(
  "private %s accepts exactly 1 MiB and rejects its next byte",
  async (channel) => {
    const invoke = (size: number) =>
      bunSelfRun({ argv: ["-e", `process.${channel}.write("x".repeat(${size}))`] }).pipe(
        Effect.provide(BunProcessRunner.layer),
      );
    const accepted = await Effect.runPromise(invoke(1024 * 1024));
    expect(accepted.mode).toBe("collected");
    if (accepted.mode !== "collected") throw new TypeError("Expected collected output");
    expect(Buffer.byteLength(accepted[channel])).toBe(1024 * 1024);
    const failure = await Effect.runPromise(Effect.flip(invoke(1024 * 1024 + 1)));
    expect(failure).toBeInstanceOf(ProcessExecError);
    expect(failure).not.toHaveProperty("exitCode");
    expect(failure).not.toHaveProperty("stdout");
  },
);

test("invocation collection rejects an overflowing child atomically and stops following stages", async () => {
  const policy = makeChildOutputPolicy({ native: false, stdin: false, stream: undefined });
  let stages = 0;
  const runner = processRunnerFor(() =>
    Effect.sync(() => {
      stages++;
      return { exitCode: 0, stdout: "x".repeat(600_000) };
    }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* bunSelfRun({ argv: ["first"] });
      yield* bunSelfRun({ argv: ["second"] });
      yield* bunSelfRun({ argv: ["third"] });
    }).pipe(
      Effect.provideService(ProcessRunner, runner),
      Effect.provideService(ChildOutput, policy),
      Effect.result,
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(stages).toBe(2);
  expect(policy.output()?.chunks).toHaveLength(1);
  expect(policy.output()?.chunks[0]?.chunk.length).toBe(600_000);
});

test("explicit credentials are absent from collected output and the single Bun lifecycle pair", async () => {
  const program = Effect.gen(function* () {
    const output = yield* bunSelfRun({
      argv: ["-e", "process.stdout.write(process.env.BUN_AUTH_TOKEN)"],
      env: { BUN_AUTH_TOKEN: "explicit-registry-credential" },
    });
    const events: readonly import("@lando/sdk/services").LandoEvent[] = yield* (yield* EventService).query(
      "*",
    );
    return { output, events };
  });
  const result = await Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(BunProcessRunner.layer, Events.layer, RedactionService.layer)),
    ),
  );
  expect(JSON.stringify(result)).not.toContain("explicit-registry-credential");
  expect(result.output).toMatchObject({ mode: "collected", stdout: "[redacted]" });
  expect(result.events.map((event) => event._tag)).toEqual(["pre-bun-self-exec", "post-bun-self-exec"]);
  expect(result.events.every((event) => !("stdout" in event) && !("stderr" in event))).toBe(true);
});

test("a caller-owned timeout stays typed without a child status", async () => {
  const runner = processRunnerFor(() =>
    Effect.fail(
      new ProcessTimeoutError({
        cmd: "fixture",
        message: "timed out",
        elapsedMs: 17,
        remediation: "Retry with more time.",
      }),
    ),
  );
  const error = await Effect.runPromise(
    Effect.flip(bunSelfRun({ argv: [] }).pipe(Effect.provideService(ProcessRunner, runner))),
  );
  expect(error).toBeInstanceOf(ProcessTimeoutError);
  expect(error).toMatchObject({ elapsedMs: 17 });
  expect(error).not.toHaveProperty("exitCode");
});

test("ordinary environment names containing secret-like substrings remain readable", async () => {
  const result = await Effect.runPromise(
    bunSelfRun({
      argv: ["-e", "process.stdout.write(process.env.SECRETARY)"],
      env: { SECRETARY: "calendar-name" },
    }).pipe(Effect.provide(Layer.mergeAll(BunProcessRunner.layer, RedactionService.layer))),
  );
  expect(result).toMatchObject({ mode: "collected", stdout: "calendar-name", exitCode: 0 });
});

test("human managed output preserves split UTF-8 and redacts explicit credentials before rendering", async () => {
  const io = createBufferedRendererIO();
  const secret = "explicit-stream-credential";
  const bytes = new TextEncoder().encode(`é ${secret}\n`);
  const runner = processRunnerFor(() => Effect.succeed({ exitCode: 0 }));
  const streaming = ProcessRunner.of({
    ...runner,
    streamWithExit: () =>
      Stream.fromIterable([
        { kind: "stdout" as const, chunk: bytes.subarray(0, 1) },
        { kind: "stdout" as const, chunk: bytes.subarray(1, 9) },
        { kind: "stdout" as const, chunk: bytes.subarray(9) },
        { kind: "stderr" as const, chunk: new TextEncoder().encode(`${secret}\n`) },
        { exitCode: 0 },
      ]),
  });
  await runWithRendererHandling(bunSelfRun({ argv: ["fixture"], env: { BUN_AUTH_TOKEN: secret } }), {
    runtime: Layer.succeed(ProcessRunner, streaming),
    rendererMode: "plain",
    resultFormat: "text",
    io,
    command: "fixture",
    render: (result) => `complete:${result.mode}`,
    setExitCode: () => {},
    formatError: () => "unexpected failure",
  });
  expect(io.stdout()).toContain("é [redacted]\n");
  expect(io.stdout()).toContain("complete:streamed");
  expect(io.stderr()).toBe("[redacted]\n");
  expect(io.stdout() + io.stderr()).not.toContain(secret);
});

test("invocation limits count raw bytes even when redaction shrinks retained output", async () => {
  const secret = "unique-credential";
  const policy = makeChildOutputPolicy({ native: false, stdin: false, stream: undefined });
  let stages = 0;
  const runner = processRunnerFor(() =>
    Effect.sync(() => {
      stages++;
      return { exitCode: 0, stdout: secret.repeat(35_000) };
    }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      for (let index = 0; index < 3; index++)
        yield* bunSelfRun({ argv: [String(index)], env: { BUN_AUTH_TOKEN: secret } });
    }).pipe(
      Effect.provideService(ProcessRunner, runner),
      Effect.provideService(ChildOutput, policy),
      Effect.provide(RedactionService.layer),
      Effect.result,
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(stages).toBe(2);
  expect(policy.output()?.chunks).toHaveLength(1);
  expect(JSON.stringify(policy.output())).not.toContain(secret);
});

test("package diagnostics prioritize stderr within one redacted UTF-8 budget", async () => {
  const error = await Effect.runPromise(
    redactPluginPackageError(
      new PluginPackageOperationError({
        commandId: "meta:plugin:remove",
        operation: "remove",
        packageSpec: "fixture",
        cwd: process.cwd(),
        message: "child failed",
        remediation: "Inspect child output.",
        exitCode: 37,
      }),
      { stderr: "stderr-id\n", stdout: "é".repeat(8192) },
    ),
  );
  expect(error.exitCode).toBe(37);
  expect(error.detail).toStartWith("stderr-id\n");
  expect(error.detail).toContain("é".repeat(8));
  expect(Buffer.byteLength(error.detail ?? "")).toBeLessThanOrEqual(8192);
  expect(error.detail).not.toContain("�");
});
