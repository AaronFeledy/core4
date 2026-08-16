import { describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService } from "@lando/core/services";
import { makeEnvSecretStoreLive } from "@lando/engine/services/secret-store";
import { RedactionServiceLive } from "@lando/redaction/service";
import type { EventServiceShape, LandoEvent } from "@lando/sdk/services";
import { type BunSelfSpawner, bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

const secretEnv = { LANDO_SECRET_AC6: "ac6secretvalue" };
const realRedactionLayer = RedactionServiceLive.pipe(
  Layer.provide(makeEnvSecretStoreLive({ env: secretEnv })),
);

describe("redaction integration on emitting surfaces", () => {
  test("resolved SecretStore values are absent from bun-self event payloads", async () => {
    const events: Array<Record<string, unknown>> = [];
    const eventLayer = Layer.succeed(EventService, {
      publish: (event: LandoEvent) => Effect.sync(() => events.push({ ...event })),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<never>(),
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    } satisfies EventServiceShape);
    const spawner: BunSelfSpawner = { spawn: async () => ({ exitCode: 0 }) };

    await Effect.runPromise(
      bunSelfRun({
        argv: ["install", "--token=ac6secretvalue"],
        env: { BUN_AUTH_TOKEN: "ac6secretvalue" },
        spawner,
        execPath: "/bin/bun",
      }).pipe(Effect.provide(Layer.mergeAll(eventLayer, realRedactionLayer))),
    );

    const payload = JSON.stringify(events);
    expect(payload).not.toContain("ac6secretvalue");
    expect(payload).toContain("[redacted]");
  });

  test("resolved SecretStore values are absent from rendered diagnostics", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.fail("ac6secretvalue failed"), {
      runtime: realRedactionLayer,
      rendererMode: "plain",
      io,
      formatError: (error) => `diagnostic: ${String(error)}`,
      setExitCode: () => undefined,
    });

    expect(io.stderr()).not.toContain("ac6secretvalue");
    expect(io.stderr()).toContain("[redacted]");
  });
});
