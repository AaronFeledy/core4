import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";
import { Context, Effect, Schema } from "effect";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import { pluginOwnedCommandEffect } from "../../src/cli/run-plugin-owned-command.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";

for (const mode of ["plugin-run", "plugin-render", "event-run"] as const) {
  test(`${mode} masks split registered bytes on both channels and flushes trailing prefixes`, async () => {
    // Given
    const secret = "command-byte-canary-4632";
    const redaction = makeRedactionService();
    const output = { stdout: "", stderr: "" };
    const write = (destination: keyof typeof output) => (chunk: string | Uint8Array) =>
      Effect.sync(() => {
        output[destination] += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      });
    const renderer = Renderer.of({
      id: "plain",
      capabilities: RENDERER_CAPABILITIES_NONE,
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: { stdout: write("stdout"), stderr: write("stderr") },
    });
    const body = Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues([secret]);
      const current = yield* Renderer;
      for (const channel of [current.output.stdout, current.output.stderr]) {
        yield* channel(new TextEncoder().encode(secret.slice(0, 10)));
        yield* channel(new TextEncoder().encode(`${secret.slice(10)}!command-by`));
      }
    });
    const spec = {
      id: "meta:test:bytes",
      namespace: "meta",
      bootstrap: "none",
      summary: "Write bytes.",
      resultSchema: Schema.Void,
      run: () => (mode === "plugin-render" ? Effect.void : body),
    } satisfies LandoCommandSpec;
    // When
    if (mode === "event-run") {
      await Effect.runPromise(
        makeEventCommandExecutor(
          Context.make(Context.Service<unknown>("test/bytes"), {}).pipe(
            Context.add(Renderer, renderer),
            Context.add(RedactionService, redaction),
          ),
          [{ spec, status: { kind: "implemented" } }],
        ).run({ command: spec.id, flags: {}, args: {}, argv: [], cwd: process.cwd() }),
      );
    } else {
      await Effect.runPromise(
        pluginOwnedCommandEffect({ ...spec, render: () => body }, [], mode === "plugin-render").pipe(
          Effect.provideService(Renderer, renderer),
          Effect.provideService(RedactionService, redaction),
        ),
      );
    }
    // Then
    expect(output).toEqual({
      stdout: "[redacted]!command-by",
      stderr: "[redacted]!command-by",
    });
  });
}
