import { describe, expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { annotateFailureContext } from "@lando/sdk/command-result";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Renderer, StreamFrameSink } from "@lando/sdk/services";
import { Cause, Effect, Layer, Option, Schema } from "effect";
import { formatBugReport } from "../../src/cli/bug-report";
import type { ResultFormat } from "../../src/cli/format-flags";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

class CommandFailure extends Schema.TaggedError<CommandFailure>()("CommandFailure", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const commandFailure = new CommandFailure({ message: "command failed", remediation: "Fix the command." });
const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
const decodeFrames = (output: string) =>
  output
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
const resultFrames = (output: string) => decodeFrames(output).filter((frame) => frame._tag === "result");

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCodes: ReadonlyArray<number>;
  /** stdout as the runtime finalizer saw it. */
  readonly stdoutAtTeardown: ReadonlyArray<string>;
}

const runWithFailingTeardown = async (
  operation: Effect.Effect<string, CommandFailure, never>,
  options: {
    readonly format: ResultFormat;
    readonly streaming?: boolean;
    readonly live?: boolean;
    readonly exitCode?: number;
    readonly jqExpression?: string;
  },
): Promise<Run> => {
  const io = createBufferedRendererIO();
  const exitCodes: number[] = [];
  const stdoutAtTeardown: string[] = [];
  const runtime = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => stdoutAtTeardown.push(io.stdout())).pipe(
        Effect.andThen(Effect.die(new Error("teardown failed"))),
      ),
    ),
  );
  await runWithRendererHandling(operation, {
    runtime,
    command: "app:exec",
    rendererMode: "plain",
    resultFormat: options.format,
    resultSchema: Schema.String,
    io,
    setExitCode: (code) => exitCodes.push(code),
    ...(options.streaming === true ? { streaming: StreamFrame } : {}),
    ...(options.live === true ? { streamingMode: "live" as const } : {}),
    ...(options.jqExpression === undefined ? {} : { jqExpression: options.jqExpression }),
    ...(options.exitCode === undefined
      ? {}
      : { completion: () => ({ ok: false as const, exitCode: options.exitCode ?? 1 }) }),
    render: (value) => value,
    formatError: (failure, redactor) =>
      formatBugReport({ ...failure, context: { commandId: "app:exec" }, rendererMode: "plain", redactor }),
  });
  return { stdout: io.stdout(), stderr: io.stderr(), exitCodes, stdoutAtTeardown };
};

const emitLiveChunk = Effect.gen(function* () {
  const sink = yield* Effect.serviceOption(StreamFrameSink);
  if (Option.isSome(sink)) yield* sink.value.emit({ _tag: "stdout", kind: "bytes", chunk: "out\n" });
  return "done";
});

describe("a failing runtime teardown", () => {
  test("turns a json success into one failure envelope that keeps the result", async () => {
    const run = await runWithFailingTeardown(Effect.succeed("done"), { format: "json" });
    const lines = run.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(decodeEnvelope(lines[0] ?? "")).toMatchObject({
      ok: false,
      result: "done",
      error: { _tag: "LandoInternalError", message: "teardown failed" },
    });
    expect(run.exitCodes).toEqual([1]);
  });

  test("adds itself to a json command failure as one cleanup error", async () => {
    const context = { restorePointIds: ["retained"], discardedRestorePointIds: ["discarded"] };
    const run = await runWithFailingTeardown(
      Effect.failCause(annotateFailureContext(Cause.fail(commandFailure), context)),
      { format: "json" },
    );
    const lines = run.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const envelope = decodeEnvelope(lines[0] ?? "");
    expect(envelope.error?._tag).toBe("CommandFailure");
    expect(envelope.error?.context).toEqual(context);
    expect(envelope.error?.additionalErrors?.map((error) => [error._tag, error.role])).toEqual([
      ["LandoInternalError", "cleanup"],
    ]);
    expect(run.exitCodes).toEqual([1]);
  });

  test("streaming jq selects the cleanup error in one terminal document after teardown", async () => {
    const run = await runWithFailingTeardown(Effect.fail(commandFailure), {
      format: "json",
      streaming: true,
      jqExpression: ".error.additionalErrors | map({code: ._tag, role, message})",
    });

    expect(run.stdoutAtTeardown).toEqual([""]);
    expect(JSON.parse(run.stdout)).toEqual([
      { code: "LandoInternalError", role: "cleanup", message: "teardown failed" },
    ]);
    expect(run.stderr).toBe("");
    expect(run.exitCodes).toEqual([1]);
  });

  test("writes one yaml failure document", async () => {
    const run = await runWithFailingTeardown(Effect.fail(commandFailure), { format: "yaml" });
    expect(run.stdout.match(/^apiVersion: v4$/gm)).toHaveLength(1);
    expect(run.stdout).toContain("_tag: CommandFailure");
    expect(run.stdout).toContain("role: cleanup");
    expect(run.exitCodes).toEqual([1]);
  });

  test("ends a buffered json frame stream with one failed result frame", async () => {
    const run = await runWithFailingTeardown(Effect.succeed("done"), { format: "json", streaming: true });
    const results = resultFrames(run.stdout);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ envelope: { ok: false, result: "done" } });
    expect(decodeFrames(run.stdout).at(-1)?._tag).toBe("result");
    expect(run.exitCodes).toEqual([1]);
  });

  for (const format of ["json", "ndjson"] as const) {
    test(`ends a live ${format} frame stream with one failed result frame after the data`, async () => {
      const run = await runWithFailingTeardown(emitLiveChunk, { format, streaming: true, live: true });
      const frames = decodeFrames(run.stdout);
      expect(frames.map((frame) => frame._tag)).toEqual(["stdout", "result"]);
      expect(frames[1]).toMatchObject({ envelope: { ok: false, error: { message: "teardown failed" } } });
      expect(run.exitCodes).toEqual([1]);
    });
  }

  test("keeps a completed run's own exit status and result", async () => {
    const run = await runWithFailingTeardown(Effect.succeed("done"), { format: "json", exitCode: 3 });
    const lines = run.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const envelope = decodeEnvelope(lines[0] ?? "");
    expect(envelope).toMatchObject({ ok: false, result: "done", error: { _tag: "LandoCommandError" } });
    expect(envelope.error?.additionalErrors?.map((error) => error.role)).toEqual(["cleanup"]);
    expect(run.exitCodes).toEqual([3]);
  });

  test("reports a human failure once, with the cleanup failure folded in", async () => {
    const run = await runWithFailingTeardown(Effect.fail(commandFailure), { format: "text" });
    expect(run.stderr.match(/code: CommandFailure/g)).toHaveLength(1);
    expect(run.stderr).toContain("Cleanup also failed (LandoInternalError)");
    expect(run.exitCodes).toEqual([1]);
  });

  test("runs before any terminal document is written", async () => {
    const run = await runWithFailingTeardown(Effect.succeed("done"), { format: "json" });
    expect(run.stdoutAtTeardown).toEqual([""]);
  });
});

describe("a command's own human render", () => {
  const runWithRender = async (teardownFails: boolean) => {
    const io = createBufferedRendererIO();
    const exitCodes: number[] = [];
    const stdoutAtTeardown: string[] = [];
    const runtime = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => stdoutAtTeardown.push(io.stdout())).pipe(
          Effect.andThen(teardownFails ? Effect.die(new Error("teardown failed")) : Effect.void),
        ),
      ),
    );
    await runWithRendererHandling(Effect.succeed("done"), {
      runtime,
      command: "app:exec",
      rendererMode: "plain",
      resultFormat: "text",
      resultSchema: Schema.String,
      io,
      setExitCode: (code) => exitCodes.push(code),
      renderEffect: (completed) =>
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          yield* renderer.output.stdout(`rendered ${completed.value}\n`);
        }),
      formatError: (failure, redactor) =>
        formatBugReport({ ...failure, context: { commandId: "app:exec" }, rendererMode: "plain", redactor }),
    });
    return { stdout: io.stdout(), stderr: io.stderr(), exitCodes, stdoutAtTeardown };
  };

  test("is written with the terminal document, after the runtime closes", async () => {
    const run = await runWithRender(false);
    expect(run.stdoutAtTeardown).toEqual([""]);
    expect(run.stdout).toBe("rendered done\n");
    expect(run.exitCodes).toEqual([0]);
  });

  test("keeps its exact bytes and the order it wrote stdout and stderr in", async () => {
    // Given a render that prints a value with no trailing newline between two stderr notes.
    const order: string[] = [];
    const buffered = createBufferedRendererIO();
    const io = {
      ...buffered,
      writeStdout: (chunk: string | Uint8Array) => {
        order.push(`out:${String(chunk)}`);
        return buffered.writeStdout(chunk);
      },
      writeStderr: (chunk: string | Uint8Array) => {
        order.push(`err:${String(chunk)}`);
        return buffered.writeStderr(chunk);
      },
    };
    // When the run completes.
    await runWithRendererHandling(Effect.succeed("done"), {
      runtime: Layer.empty,
      command: "app:exec",
      rendererMode: "plain",
      resultFormat: "text",
      resultSchema: Schema.String,
      io,
      setExitCode: () => undefined,
      renderEffect: () =>
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          yield* renderer.output.stderr("before\n");
          // A multi-byte character split across two writes, with a stderr write between them.
          // The first chunk is a reused buffer, overwritten after the write, as a read loop would.
          const reused = Buffer.from([0x74, 0xc3]);
          yield* renderer.output.stdout(reused);
          reused.fill(0x21);
          yield* renderer.output.stderr("mid\n");
          yield* renderer.output.stdout(new Uint8Array([0xa9]));
          yield* renderer.output.stderr("after\n");
        }),
      formatError: ({ error }) => String(error),
    });
    // Then the value is not given a newline, and the streams keep their order.
    expect(buffered.stdout()).toBe("t\u00e9");
    expect(order).toEqual(["err:before\n", "out:116,195", "err:mid\n", "out:169", "err:after\n"]);
  });

  test("still precedes a teardown failure's one report", async () => {
    const run = await runWithRender(true);
    expect(run.stdoutAtTeardown).toEqual([""]);
    expect(run.stdout).toBe("rendered done\n");
    expect(run.stderr.match(/code: LandoInternalError/g)).toHaveLength(1);
    expect(run.exitCodes).toEqual([1]);
  });
});

describe("the terminal commit", () => {
  test("writes nothing more when the exit-status setter throws after the document", async () => {
    const io = createBufferedRendererIO();
    const exitCodes: number[] = [];
    await runWithRendererHandling(Effect.succeed("done"), {
      runtime: Layer.empty,
      command: "app:info",
      rendererMode: "plain",
      resultFormat: "json",
      resultSchema: Schema.String,
      io,
      setExitCode: (code) => {
        exitCodes.push(code);
        throw new Error("exit setter failed");
      },
      formatError: ({ error }) => String(error),
    });
    expect(io.stdout().trim().split("\n")).toHaveLength(1);
    expect(decodeEnvelope(io.stdout().trim())).toMatchObject({ ok: true, result: "done" });
    expect(exitCodes).toEqual([0]);
  });

  test("a terminal write that fails partway still sets a failure status once", async () => {
    // Given stdout that accepts nothing once the terminal document starts.
    const io = {
      ...createBufferedRendererIO(),
      writeStdout: () => {
        throw new Error("stdout write failed");
      },
    };
    const exitCodes: number[] = [];
    // When a successful json run writes its envelope.
    await runWithRendererHandling(Effect.succeed("done"), {
      runtime: Layer.empty,
      command: "app:info",
      rendererMode: "plain",
      resultFormat: "json",
      resultSchema: Schema.String,
      io,
      setExitCode: (code) => exitCodes.push(code),
      formatError: ({ error }) => String(error),
    });
    // Then the run fails once instead of exiting 0 with no result.
    expect(exitCodes).toEqual([1]);
  });

  test("an interrupted live stream ends in one interruption result frame", async () => {
    const io = createBufferedRendererIO();
    const exitCodes: number[] = [];
    const controller = new AbortController();
    await runWithRendererHandling(
      Effect.gen(function* () {
        yield* emitLiveChunk;
        controller.abort("SIGINT");
        return yield* Effect.never;
      }),
      {
        runtime: Layer.empty,
        command: "app:exec",
        rendererMode: "plain",
        resultFormat: "json",
        resultSchema: Schema.String,
        streaming: StreamFrame,
        streamingMode: "live",
        signal: controller.signal,
        io,
        setExitCode: (code) => exitCodes.push(code),
        formatError: ({ error }) => String(error),
      },
    );
    const results = resultFrames(io.stdout());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ envelope: { ok: false, error: { _tag: "CommandInterruptedError" } } });
    expect(exitCodes).toEqual([130]);
  });
});
