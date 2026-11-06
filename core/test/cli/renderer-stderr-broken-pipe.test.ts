import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.each(["before-narration", "mid-run", "stalled-live-write"] as const)(
  "closed stderr interrupts scopes with stdout open (%s)",
  async (scenario) => {
    // Given
    const script = `
      import { Effect, Layer } from "effect";
      import { EventService } from "@lando/sdk/services";
      import { createStdioRendererIO, installBrokenPipeExitPolicy } from "@lando/renderer/io";
      import { writeResultLine, writeDiagnosticLine } from "@lando/renderer/output";
      import { runWithRendererHandling } from "./core/src/cli/renderer-boundary.ts";
      import { stalledOutput } from "./core/test/cli/renderer-stalled-output.ts";
      installBrokenPipeExitPolicy();
      const scenario = ${JSON.stringify(scenario)};
      const stalled = scenario === "stalled-live-write" ? stalledOutput() : undefined;
      const stdin = new Response(Bun.stdin.stream()).text();
      let finalized = false;
      const running = runWithRendererHandling(Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true; }));
        if (stalled) {
          yield* (yield* EventService).publish({
            _tag: "message.info", body: "in-flight", timestamp: "2026-10-30T00:00:00.000Z"
          });
          yield* Effect.promise(() => stalled.started);
          process.stdout.write(stalled.chunks.join(""));
        } else {
          if (scenario === "mid-run") yield* writeDiagnosticLine("first narration");
          yield* writeResultLine("ready");
        }
        yield* Effect.promise(() => stdin);
        yield* writeDiagnosticLine("closed reader");
        yield* Effect.never;
      }).pipe(Effect.scoped), {
        runtime: Layer.empty, rendererMode: "plain", resultFormat: stalled ? "json" : "text",
        ...(stalled ? { streamingMode: "live", io: createStdioRendererIO(stalled.stream, process.stderr) } : {}),
        formatError: () => "UNEXPECTED DIAGNOSTIC"
      });
      await running;
      process.stdout.write("finalized=" + finalized + "\\n");
    `;
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: resolve(import.meta.dir, "../../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const chunks: Uint8Array[] = [];
    // When
    try {
      const first = await reader.read();
      if (first.done) throw new Error("child closed stdout before the handshake");
      chunks.push(first.value);
      const stderrReader = proc.stderr.getReader();
      let initialNarration = "";
      if (scenario === "mid-run") {
        const narration = await stderrReader.read();
        if (narration.done) throw new Error("child closed stderr before narration");
        initialNarration = new TextDecoder().decode(narration.value);
      }
      await stderrReader.cancel();
      proc.stdin.end();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      const exitCode = await proc.exited;
      // Then
      const stdout = Buffer.concat(chunks).toString();
      expect(exitCode).toBe(141);
      expect(initialNarration).toBe(scenario === "mid-run" ? "first narration\n" : "");
      if (scenario === "stalled-live-write") {
        const [frame, finalized, end] = stdout.split("\n");
        expect(JSON.parse(frame ?? "")).toEqual({
          _tag: "event",
          event: "message.info",
          payload: {
            _tag: "message.info",
            body: "in-flight",
            timestamp: "2026-10-30T00:00:00.000Z",
          },
        });
        expect([finalized, end]).toEqual(["finalized=true", ""]);
      } else expect(stdout).toBe("ready\nfinalized=true\n");
    } finally {
      reader.releaseLock();
      proc.kill();
      await proc.exited;
    }
  },
  10000,
);
