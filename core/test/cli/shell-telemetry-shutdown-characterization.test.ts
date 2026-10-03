import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("a source-mode command exits after interrupting a hanging telemetry sink", async () => {
  // Given: inject at the transport seam because the CLI has no hanging-sink environment option.
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const script = String.raw`
    import { Deferred, Effect, Layer } from "effect";
    import { Telemetry } from "@lando/sdk/services";
    import { makeTelemetryLayer, TelemetrySinks } from "@lando/telemetry/service";
    import { runWithRendererHandling } from "./core/src/cli/renderer-boundary.ts";
    const started = Effect.runSync(Deferred.make());
    const runtime = makeTelemetryLayer(true, { flushBudgetMillis: 50 }).pipe(
      Layer.provide(Layer.succeed(TelemetrySinks, [{
        id: "hanging-characterization-sink",
        record: () => Deferred.succeed(started, undefined).pipe(
          Effect.tap(() => Effect.sync(() => console.error("sink-started"))),
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => console.error("sink-interrupted"))),
        ),
      }])),
    );
    await runWithRendererHandling(Effect.gen(function* () {
      const telemetry = yield* Telemetry;
      yield* telemetry.record("update-outcome", { outcome: "success" });
      yield* Deferred.await(started);
      return "completed";
    }), {
      runtime, rendererMode: "plain", command: "meta:characterize",
      render: (value) => value, formatError: String,
    });
    console.log("closed");
  `;

  // When: an actual Bun process must naturally exit, not merely resolve a promise in the test runner.
  const start = performance.now();
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, LANDO_DEBUG_CAUSE_CHAIN: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // Then: allow source startup overhead, while bounding the real 50 ms flush.
  expect({ stdout, stderr, exitCode }).toEqual({
    stdout: "completed\nclosed\n",
    stderr: "sink-started\nsink-interrupted\n",
    exitCode: 0,
  });
  expect(performance.now() - start).toBeLessThan(2_500);
}, 10_000);
