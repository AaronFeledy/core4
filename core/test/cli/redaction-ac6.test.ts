import { describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService } from "@lando/core/services";
import * as EnvironmentResolver from "@lando/engine/services/environment-value-resolver";
import * as EnvSecretStore from "@lando/engine/services/secret-store";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import type { EventServiceShape, LandoEvent } from "@lando/sdk/services";
import { EnvironmentValueResolver } from "@lando/sdk/services";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { withProcess } from "../_support/process-runner.ts";

const secretEnv = { LANDO_SECRET_AC6: "ac6secretvalue" };
const realRedactionLayer = EnvironmentResolver.layer.pipe(
  Layer.provideMerge(RedactionService.layer),
  Layer.provide(EnvSecretStore.layerWith({ env: secretEnv })),
);

describe("redaction integration on emitting surfaces", () => {
  test("resolved SecretStore values are absent from bun-self event payloads", async () => {
    const events: Array<Record<string, unknown>> = [];
    const eventLayer = Layer.succeed(
      EventService,
      EventService.of({
        publish: (event: LandoEvent) => Effect.sync(() => events.push({ ...event })),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<never>(),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      } satisfies EventServiceShape),
    );

    await Effect.runPromise(
      bunSelfRun({
        argv: ["install", "--token=ac6secretvalue"],
        env: { BUN_AUTH_TOKEN: "ac6secretvalue" },
        execPath: "/bin/bun",
      }).pipe(
        withProcess(async () => ({ exitCode: 0 })),
        Effect.provide(Layer.mergeAll(eventLayer, realRedactionLayer)),
      ),
    );

    const payload = JSON.stringify(events);
    expect(payload).not.toContain("ac6secretvalue");
    expect(payload).toContain("[redacted]");
  });

  test("resolved SecretStore values are absent from rendered diagnostics", async () => {
    const io = createBufferedRendererIO();
    const diagnostic = Effect.scoped(
      Effect.gen(function* () {
        const resolver = yield* EnvironmentValueResolver;
        const session = yield* resolver.openSession();
        const environment = yield* session.resolveEnvironment({
          TOKEN: { _tag: "SecretRef", reference: "AC6" },
        });
        return yield* Effect.fail(`${environment.TOKEN} failed`);
      }),
    );
    await runWithRendererHandling(diagnostic, {
      runtime: realRedactionLayer,
      rendererMode: "plain",
      io,
      formatError: ({ error }) => `diagnostic: ${String(error)}`,
      setExitCode: () => undefined,
    });

    expect(io.stderr()).not.toContain("ac6secretvalue");
    expect(io.stderr()).toContain("[redacted]");
  });
});
