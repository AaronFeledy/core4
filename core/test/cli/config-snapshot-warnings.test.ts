import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfigSnapshot } from "@lando/engine/services/config";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Context, Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { makeLandoRuntime } from "../../src/runtime/layer";

test.each(["plain", "json"] as const)(
  "flushes retained config warnings once after %s consumers attach",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-config-warnings-"));
    await writeFile(join(root, "config.yml"), "defaultProvidreId: docker\n");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              makeLandoRuntime({
                bootstrap: "minimal",
                configSources: { env: false },
                config: { userConfRoot: root },
              }),
            );
            const snapshot = Context.get(context, GlobalConfigSnapshot);
            expect(snapshot.warnings).toHaveLength(1);
            const outputs: string[] = [];
            for (let invocation = 0; invocation < 2; invocation++) {
              const io = createBufferedRendererIO();
              yield* Effect.promise(() =>
                runWithRendererHandling(Effect.succeed({ done: true }), {
                  runtime: Layer.succeedContext(context),
                  rendererMode: mode,
                  resultFormat: mode === "json" ? "json" : "text",
                  command: "config-warning-fixture",
                  sourceEnv: {},
                  io,
                  resultSchema: Schema.Struct({ done: Schema.Boolean }),
                  formatError: ({ error }) => String(error),
                  setExitCode: (code) => expect(code).toBe(0),
                }),
              );
              outputs.push(mode === "json" ? io.stdout() : io.stderr());
            }
            expect(outputs[0]?.match(/defaultProvidreId/g)).toHaveLength(1);
            expect(outputs[1]).not.toContain("defaultProvidreId");
            expect(snapshot.warnings).toHaveLength(1);
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
