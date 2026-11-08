import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { compiledCommandOptionsFromSpec } from "../../src/cli/run-built-in-command";
import { makeTestEventService } from "../../src/testing/test-runtime-events";

describe("canonical CLI completion", () => {
  test("keeps report findings successful while setting the findings exit code", async () => {
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    await runWithRendererHandling(Effect.succeed(false), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      command: "app:config:lint",
      invocation: { commandId: "app:config:lint", argv: [], args: {}, flags: {}, cwd: "/workspace" },
      resultSchema: Schema.Boolean,
      io,
      completion: () => ({ ok: true, exitCode: 1 }),
      setExitCode: (code) => {
        codes.push(code);
      },
      formatError: () => "must not render",
    });
    expect(codes).toEqual([1]);
    expect(JSON.parse(io.stdout())).toMatchObject({ ok: true, result: false });
    expect(io.stderr()).not.toContain("must not render");
  });
  test.each(["text", "json"] as const)(
    "resolves process failure once after producer finalizers for %s",
    async (format) => {
      const io = createBufferedRendererIO();
      const codes: number[] = [];
      const events: LandoEvent[] = [];
      const order: string[] = [];
      let calls = 0;
      const eventService = makeTestEventService(events);
      const input = { args: {}, flags: { count: 7 }, argv: [] };
      const spec = {
        id: "app:exec",
        namespace: "app" as const,
        bootstrap: "minimal" as const,
        summary: "Process",
        resultSchema: Schema.Struct({ exitCode: Schema.Number }),
        run: () => Effect.succeed({ exitCode: 7 }),
        completion: (_value: unknown, normalized: unknown) => {
          expect(normalized).toBe(input);
          calls++;
          order.push("completion");
          return commandCompletionFromExitCode(7);
        },
      };
      await runWithRendererHandling(
        Effect.gen(function* () {
          const optionalSink = yield* Effect.serviceOption(StreamFrameSink);
          if (optionalSink._tag === "None") return yield* Effect.die(new Error("missing live sink"));
          const sink = optionalSink.value;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              order.push("producer");
            }).pipe(Effect.andThen(sink.emit({ kind: "bytes", _tag: "stdout", chunk: "final tail" }))),
          );
          return { exitCode: 7 };
        }).pipe(Effect.scoped),
        {
          ...compiledCommandOptionsFromSpec(spec, input),
          runtime: Layer.succeed(EventService, eventService),
          rendererMode: "plain",
          resultFormat: format,
          streamingMode: "live",
          command: spec.id,
          invocation: { commandId: spec.id, ...input, cwd: "/workspace" },
          resultSchema: spec.resultSchema,
          io,
          render: () => "typed result",
          formatError: () => "BUG REPORT MUST NOT RENDER",
          setExitCode: (code) => {
            codes.push(code);
          },
        },
      );
      expect(order).toEqual(["producer", "completion"]);
      expect(calls).toBe(1);
      expect(codes).toEqual([7]);
      expect(events.at(-1)).toMatchObject({
        _tag: "cli-app:exec-error",
        exitCode: 7,
        failureTag: "LandoCommandError",
      });
      expect(io.stderr()).not.toContain("BUG REPORT");
      if (format === "json") {
        const frames = io
          .stdoutLines()
          .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
        expect(frames.filter((frame) => frame._tag === "stdout")).toEqual([
          { _tag: "stdout", chunk: "final tail" },
        ]);
        expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.event)).toEqual([
          "cli-app:exec-init",
          "cli-app:exec-error",
        ]);
        expect(frames.at(-1)).toMatchObject({
          _tag: "result",
          envelope: { ok: false, result: { exitCode: 7 }, error: { _tag: "LandoCommandError" } },
        });
      } else expect(io.stdout()).toContain("final tail");
    },
  );

  test("does not invoke completion policy on an actual command failure", async () => {
    let calls = 0;
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.fail({ _tag: "ExpectedFailure", message: "failed" }), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      command: "app:exec",
      resultSchema: Schema.Unknown,
      io,
      setExitCode: () => {},
      formatError: () => "failed",
      completion: () => {
        calls++;
        return { ok: true, exitCode: 0 };
      },
    });
    expect(calls).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({ ok: false, error: { _tag: "ExpectedFailure" } });
  });
});
