import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandStdioError, type EventError } from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { CommandPayloadStdout } from "../../src/cli/command-payload-stdout";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { pluginOwnedCommandEffect } from "../../src/cli/run-plugin-owned-command";

test.each([false, true])(
  "live JSON keeps payload on stdout and frames on stderr (failure=%s)",
  async (fail) => {
    const io = createBufferedRendererIO();
    const resultSchema = Schema.Struct({ exported: Schema.Boolean });
    const payload = new Uint8Array([0, 255, 10, 13, 65]);
    const codes: number[] = [];
    const spec = {
      id: "fixture:dump",
      namespace: "fixture",
      bootstrap: "plugins",
      args: { file: { type: "string", stdio: "stdout" } },
      resultSchema,
      run: (input) =>
        Effect.gen(function* () {
          const write = input.stdio?.stdout;
          if (write === undefined) throw new Error("expected stdout grant");
          yield* write(payload);
          yield* (yield* EventService).publish({
            _tag: "message.info",
            body: "exporting",
            timestamp: "2026-11-04T00:00:00.000Z",
          });
          const sink = yield* Effect.serviceOption(StreamFrameSink);
          if (sink._tag === "None") throw new Error("expected live sink");
          yield* sink.value.emit({ _tag: "stdout", kind: "bytes", chunk: "progress\n" });
          if (fail)
            return yield* Effect.fail(
              new CommandStdioError({
                command: "fixture:dump",
                stream: "stdin",
                reason: "read",
                message: "fixture failure",
                remediation: "Retry the fixture.",
              }),
            );
          return { exported: true };
        }),
    } satisfies ExecutableCommandSpec<typeof resultSchema.Type, CommandStdioError | EventError, EventService>;

    await runWithRendererHandling(pluginOwnedCommandEffect(spec, ["-"], false, { resultFormat: "json" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      streamingMode: "live",
      payloadStdout: true,
      command: spec.id,
      resultSchema,
      io,
      setExitCode: (code) => codes.push(code),
      formatError: () => "unexpected failure",
    });

    expect(io.stdoutBytes()).toEqual(payload);
    const frames = io.stderrLines().map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
    expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.event)).toEqual([
      "message.info",
    ]);
    expect(frames.filter((frame) => frame._tag === "stdout")).toEqual([
      { _tag: "stdout", chunk: "progress\n" },
    ]);
    expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      _tag: "result",
      envelope: { ok: !fail, ...(fail ? {} : { result: { exported: true } }) },
    });
    expect(codes).toEqual([fail ? 1 : 0]);
  },
);

test("SIGINT preserves the stdout payload and emits one interrupted envelope on stderr", async () => {
  const io = createBufferedRendererIO();
  const controller = new AbortController();
  const codes: number[] = [];
  await runWithRendererHandling(
    Effect.gen(function* () {
      const payload = yield* Effect.serviceOption(CommandPayloadStdout);
      if (payload._tag === "None") throw new Error("expected payload writer");
      yield* payload.value(new TextEncoder().encode("dump"));
      controller.abort("SIGINT");
      return yield* Effect.never;
    }),
    {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      payloadStdout: true,
      signal: controller.signal,
      io,
      setExitCode: (code) => codes.push(code),
      formatError: () => "unexpected failure",
    },
  );
  expect(io.stdout()).toBe("dump");
  expect(JSON.parse(io.stderr())).toMatchObject({
    ok: false,
    error: { _tag: "CommandInterruptedError", signal: "SIGINT" },
  });
  expect(codes).toEqual([130]);
});

test.each(["stdout", "stderr"] as const)(
  "closing payload-mode %s interrupts the command and exits 141",
  async (closed) => {
    const script = `
    import { Effect, Layer } from "effect";
    import { createStdioRendererIO, installBrokenPipeExitPolicy } from "@lando/renderer/io";
    import { writeResultLine } from "@lando/renderer/output";
    import { CommandPayloadStdout } from "./core/src/cli/command-payload-stdout.ts";
    import { runWithRendererHandling } from "./core/src/cli/renderer-boundary.ts";
    installBrokenPipeExitPolicy();
    const io = createStdioRendererIO();
    const input = new Response(Bun.stdin.stream()).text();
    let finalized = false;
    await runWithRendererHandling(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true; }));
      const payload = yield* CommandPayloadStdout;
      yield* payload(new TextEncoder().encode("ready\\n"));
      yield* Effect.promise(() => input);
      yield* ${closed === "stdout" ? 'payload(new TextEncoder().encode("closed reader"))' : 'writeResultLine("closed reader")'};
      yield* Effect.never;
    }).pipe(Effect.scoped), {
      runtime: Layer.empty, rendererMode: "plain", resultFormat: "json", payloadStdout: true,
      io, formatError: () => "UNEXPECTED DIAGNOSTIC"
    });
    io.${closed === "stdout" ? "writeStderr" : "writeStdout"}("finalized=" + finalized + "\\n");
  `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: resolve(import.meta.dir, "../../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toBe("ready\n");
      let remaining: Promise<string>;
      if (closed === "stdout") {
        await reader.cancel();
        remaining = new Response(child.stderr).text();
      } else {
        await child.stderr.cancel();
        remaining = (async () => {
          const chunks: Uint8Array[] = [];
          for (;;) {
            const next = await reader.read();
            if (next.done) return Buffer.concat(chunks).toString();
            chunks.push(next.value);
          }
        })();
      }
      child.stdin.end();
      expect(await remaining).toBe("finalized=true\n");
      expect(await child.exited).toBe(141);
    } finally {
      reader.releaseLock();
      child.kill();
      await child.exited;
    }
  },
  10000,
);
