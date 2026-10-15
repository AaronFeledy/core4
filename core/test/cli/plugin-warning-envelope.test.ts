import { expect, test } from "bun:test";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import type { EventError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { recordCommandWarning } from "../../src/cli/command-warnings.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const timestamp = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");
const secret = "issue1319-private-warning-token";
const ResultSchema = Schema.Struct({ done: Schema.Boolean });

// Like plugin render publishers, this service retains the runtime's EventService
// before the CLI starts executing the command.
class PluginPublisher extends Context.Service<
  PluginPublisher,
  { readonly warn: (body: string) => Effect.Effect<void, EventError> }
>()("@lando/test/PluginPublisher") {}

const pluginLayer = Layer.effect(
  PluginPublisher,
  Effect.gen(function* () {
    const events = yield* EventService;
    const control = yield* LandoEventService.EventDispatchControl;
    yield* control.install({
      hasSubscribers: (name) => name === "cli-warning-fixture-run" || name === "cli-warning-fixture-error",
      dispatch: () =>
        events.publish(MessageWarnEvent.make({ body: "terminal subscriber warning", timestamp })),
    });
    return PluginPublisher.of({
      warn: (body) => events.publish(MessageWarnEvent.make({ body, timestamp })),
    });
  }),
).pipe(Layer.provideMerge(LandoEventService.layerRuntime));

for (const resultFormat of ["json", "yaml"] as const) {
  for (const transport of ["envelope", "buffered", "live"] as const) {
    for (const fails of [false, true]) {
      const outcome = fails ? "fails" : "succeeds";
      test(`retains plugin warnings in ${resultFormat} ${transport} when the command ${outcome}`, async () => {
        // Given: a retained plugin publisher and an existing coded warning.
        const io = createBufferedRendererIO();
        let exitCode = 0;
        const command = Effect.gen(function* () {
          const plugin = yield* PluginPublisher;
          const events = yield* EventService;
          yield* recordCommandWarning({
            code: "EXISTING_WARNING",
            message: "coded warning",
            remediation: "Keep this.",
          });
          yield* plugin.warn(`early warning ${secret}`);
          for (let index = 0; index < 80; index++) {
            yield* events.publish({ _tag: "message.info", body: `later event ${index}`, timestamp });
          }
          if (transport === "live") {
            const sink = yield* StreamFrameSink;
            yield* sink.emit({ _tag: "stdout", chunk: "streamed chunk\n" });
          }
          yield* plugin.warn("last command warning");
          if (fails) return yield* Effect.fail({ _tag: "FixtureFailure", message: "command failed" });
          return { done: true };
        });

        // When: the real boundary runs and emits its terminal result.
        await runWithRendererHandling(command, {
          runtime: pluginLayer,
          rendererMode: "json",
          resultFormat,
          command: "warning-fixture",
          invocation: { commandId: "warning-fixture", argv: [], args: {}, flags: {}, cwd: "/fixture" },
          resultSchema: ResultSchema,
          ...(transport === "envelope" ? {} : { streaming: StreamFrame }),
          ...(transport === "live" ? { streamingMode: "live" } : {}),
          ...(transport === "buffered"
            ? { streamFrames: () => [{ _tag: "stdout", chunk: "buffered chunk\n" }] as const }
            : {}),
          extraRedactionTokens: [secret],
          sourceEnv: {},
          io,
          formatError: String,
          setExitCode: (code) => {
            exitCode = code;
          },
        });

        // Then: schema-valid terminal warnings survive history eviction and
        // terminal publication, without duplicating coded warnings or secrets.
        let document: unknown;
        if (resultFormat === "yaml") {
          document = Bun.YAML.parse(io.stdout());
        } else if (transport === "envelope") {
          document = JSON.parse(io.stdout());
        } else {
          const frames = io
            .stdoutLines()
            .filter(Boolean)
            .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
          const terminal = frames.find((frame) => frame._tag === "result");
          expect(terminal).toBeDefined();
          document = terminal?._tag === "result" ? terminal.envelope : undefined;
        }
        const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(document);
        expect(envelope.warnings).toEqual([
          { code: "EXISTING_WARNING", message: "coded warning", remediation: "Keep this." },
          { code: "LANDO_MESSAGE_WARN", message: "early warning [redacted]" },
          { code: "LANDO_MESSAGE_WARN", message: "last command warning" },
          { code: "LANDO_MESSAGE_WARN", message: "terminal subscriber warning" },
        ]);
        expect(envelope.ok).toBe(!fails);
        expect(exitCode).toBe(fails ? 1 : 0);
        expect(io.stdout()).not.toContain(secret);
        expect(io.stderr()).toBe("");
      });
    }
  }
}

test("retains plugin warnings when the runtime publishes during layer acquisition", async () => {
  // Given: a plugin runtime that publishes before command execution begins.
  const io = createBufferedRendererIO();
  const runtime = Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(MessageWarnEvent.make({ body: "runtime warning", timestamp }));
    }),
  ).pipe(Layer.provideMerge(LandoEventService.layerRuntime));
  // When: the boundary acquires the runtime and emits the result.
  await runWithRendererHandling(Effect.succeed({ done: true }), {
    runtime,
    rendererMode: "json",
    resultFormat: "json",
    resultSchema: ResultSchema,
    io,
    formatError: String,
    setExitCode: () => undefined,
  });
  // Then: acquisition warnings reach the same command-local envelope.
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
  expect(envelope.warnings).toEqual([{ code: "LANDO_MESSAGE_WARN", message: "runtime warning" }]);
});

test("retains encoded warning events when using the fallback event service", async () => {
  // Given: an encoded event, the other supported EventService payload shape.
  const io = createBufferedRendererIO();
  const command = Effect.gen(function* () {
    const events = yield* EventService;
    yield* events.publish({
      _tag: "message.warn",
      body: "encoded warning",
      timestamp: DateTime.formatIso(timestamp),
    });
    return { done: true };
  });
  // When: a command runs without a runtime-provided EventService.
  await runWithRendererHandling(command, {
    runtime: Layer.empty,
    rendererMode: "json",
    resultFormat: "json",
    resultSchema: ResultSchema,
    io,
    formatError: String,
    setExitCode: () => undefined,
  });
  // Then: the encoded warning is retained too.
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
  expect(envelope.warnings).toEqual([{ code: "LANDO_MESSAGE_WARN", message: "encoded warning" }]);
});

test("keeps human warning rendering when using a retained plugin publisher", async () => {
  // Given: a human command with the same plugin publication seam.
  const io = createBufferedRendererIO();
  const command = Effect.gen(function* () {
    const plugin = yield* PluginPublisher;
    yield* plugin.warn("human warning");
    return { done: true };
  });
  // When: the boundary selects text instead of an envelope.
  await runWithRendererHandling(command, {
    runtime: pluginLayer,
    rendererMode: "plain",
    resultFormat: "text",
    io,
    render: () => "done",
    formatError: String,
    setExitCode: () => undefined,
  });
  // Then: the warning and result use separate streams.
  expect(io.stdout()).toBe("done\n");
  expect(io.stderr()).toBe("⚠ human warning\n");
});
