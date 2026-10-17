import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { EventService, Renderer } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const payload = "alpha\nbeta\npartial";
const resultSchema = Schema.Struct({ value: Schema.String });

for (const stdoutTTY of [false, true]) {
  for (const stderrTTY of [false, true]) {
    test(`diagnostic styling follows stderr=${stderrTTY}, independently of stdout=${stdoutTTY}`, async () => {
      const io = createBufferedRendererIO({ isTTY: stderrTTY, stdoutIsTTY: stdoutTTY });
      await runWithRendererHandling(Effect.fail("failure"), {
        runtime: Layer.empty,
        rendererMode: "lando",
        io,
        formatError: () => "failure\ncode: MatrixFailure",
        setExitCode: (code) => {
          expect(code).toBe(1);
        },
      });
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe(
        stderrTTY ? "failure\n\u001b[2mcode: MatrixFailure\u001b[22m\n" : "failure\ncode: MatrixFailure\n",
      );
    });
  }
}

for (const mode of ["lando", "plain", "json", "verbose"] as const) {
  for (const stdoutTTY of [false, true]) {
    for (const stderrTTY of [false, true]) {
      for (const shape of ["live", "text", "envelope"] as const) {
        test(`6a ${mode} stdoutTTY=${stdoutTTY} stderrTTY=${stderrTTY} ${shape}`, async () => {
          const buffer = createBufferedRendererIO({
            isTTY: stderrTTY,
            stdoutIsTTY: stdoutTTY,
            terminalColumns: 60,
            terminalRows: 24,
            stdoutColumns: 100,
          });
          const resize = new EventEmitter();
          const terminal = new Proxy(process.stderr, {
            get: (target, key) => {
              if (key === "write")
                return (chunk: string) => {
                  buffer.writeStderr(chunk);
                  return true;
                };
              if (key === "on") return resize.on.bind(resize);
              if (key === "off") return resize.off.bind(resize);
              if (key === "columns") return 60;
              if (key === "rows") return 24;
              return Reflect.get(target, key);
            },
          });
          const io = { ...buffer, externalOutputStream: terminal };
          await runWithRendererHandling(
            Effect.gen(function* () {
              const events = yield* EventService;
              const renderer = yield* Renderer;
              yield* events.publish({
                _tag: "task.tree.start",
                parentId: "tooling:gen",
                label: "Generating",
                children: ["tooling:gen:exec"],
                timestamp: "2026-06-04T00:00:00.000Z",
              });
              yield* events.publish({
                _tag: "task.start",
                taskId: "tooling:gen:exec",
                parentId: "tooling:gen",
                label: "gen",
                timestamp: "2026-06-04T00:00:00.000Z",
              });
              yield* Effect.yieldNow;
              yield* renderer.message.info("matrix-narration");
              if (shape === "live") {
                const sink = yield* StreamFrameSink;
                yield* sink.emit({ _tag: "stdout", chunk: "alpha\nbeta\n", raw: true });
                yield* sink.emit({ _tag: "stdout", chunk: "partial", raw: true });
                yield* sink.emit({ _tag: "stderr", chunk: "tool-diagnostic\n", raw: true });
              }
              return { value: "result" };
            }),
            {
              runtime: Layer.empty,
              rendererMode: mode,
              io,
              command: "app:gen",
              resultSchema,
              resultFormat: shape === "envelope" ? "json" : "text",
              ...(shape === "live" ? { streamingMode: "live" as const } : {}),
              render: (value, context) => {
                expect(context.isTTY).toBe(stdoutTTY);
                expect(context.columns).toBe(100);
                return `${value.value}:${context.isTTY ? "terminal" : "pipe"}`;
              },
              formatError: String,
              setExitCode: (code) => {
                expect(code).toBe(0);
              },
            },
          );
          const expected =
            shape === "live"
              ? payload
              : shape === "text"
                ? `result:${stdoutTTY ? "terminal" : "pipe"}\n`
                : '{"apiVersion":"v4","command":"app:gen","ok":true,"result":{"value":"result"},"warnings":[],"deprecations":[]}\n';
          expect(buffer.stdout()).toBe(expected);
          expect(buffer.stderr()).toContain("matrix-narration");
          if (shape === "live") expect(buffer.stderr()).toContain("tool-diagnostic");
          if (mode === "lando" && stderrTTY && shape !== "envelope") {
            expect(buffer.stderr()).toContain("╭─");
          }
        });
      }
    }
  }
}
