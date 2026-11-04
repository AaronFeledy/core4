import { expect, test } from "bun:test";
import * as Resolver from "@lando/engine/services/environment-value-resolver";
import * as Events from "@lando/engine/services/event-service";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { MessageInfoEvent } from "@lando/sdk/events";
import { StreamFrame } from "@lando/sdk/schema";
import { EnvironmentValueResolver, EventService, Renderer, SecretStore } from "@lando/sdk/services";
import { DateTime, Effect, Layer, Queue, Schema } from "effect";
import { withRedactedRenderer } from "../../src/cli/redacted-renderer.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const ValueSchema = Schema.Struct({ value: Schema.String });

const fixture = () => {
  const reads: string[] = [];
  const canary = "late-runtime-value:@/ü";
  const store = Layer.succeed(
    SecretStore,
    SecretStore.of({
      id: "requested-only",
      get: (id) =>
        Effect.sync(() => {
          reads.push(id);
          if (id !== "requested") throw new TypeError("Unexpected secret lookup");
          return canary;
        }),
      has: () => Effect.die("Unexpected secret probe"),
      list: Effect.die("Rendering must not list secrets"),
    }),
  );
  const redaction = RedactionService.layer;
  const dependencies = Layer.mergeAll(redaction, store);
  const runtime = Layer.mergeAll(
    dependencies,
    Resolver.layer.pipe(Layer.provide(dependencies)),
    Events.layerRuntime.pipe(Layer.provide(redaction)),
  );
  const resolve = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      return yield* session.resolveEnvironment({ VALUE: { _tag: "SecretRef", reference: "requested" } });
    }),
  );
  return { runtime, resolve, reads, canary };
};

test.each(["text", "json", "yaml"] as const)(
  "late %s buffered result remains masked after operation and runtime subscopes close",
  async (format) => {
    // Given
    const h = fixture();
    const io = createBufferedRendererIO({ isTTY: false });
    const effect = h.resolve.pipe(Effect.map((env) => ({ value: env.VALUE ?? "missing" })));
    // When
    await runWithRendererHandling(effect, {
      runtime: h.runtime,
      io,
      rendererMode: "plain",
      resultFormat: format,
      resultSchema: ValueSchema,
      command: "test:redaction-lifetime",
      render: (value) => value.value,
      formatError: ({ error }) => String(error),
      setExitCode: () => undefined,
      deprecationWarnings: false,
    });
    // Then
    expect(h.reads).toEqual(["requested"]);
    expect(io.stdout()).toContain("[redacted]");
    expect(io.stdout() + io.stderr()).not.toContain(h.canary);
    if (format === "json") expect(JSON.parse(io.stdout()).result.value).toBe("[redacted]");
    if (format === "yaml")
      expect(Bun.YAML.parse(io.stdout())).toMatchObject({ result: { value: "[redacted]" } });
  },
);

test.each(["error", "defect", "interrupt", "success"] as const)(
  "%s preserves masking through finalizers and buffered stdout/stderr flush",
  async (outcome) => {
    // Given
    const h = fixture();
    const io = createBufferedRendererIO({ isTTY: false });
    const effect = withRedactedRenderer(
      Effect.gen(function* () {
        yield* h.resolve;
        const renderer = yield* Renderer;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => renderer.output.stderr(Buffer.from(`${h.canary}\n`)));
            yield* renderer.output.stdout(Buffer.from(h.canary.slice(0, 8)));
            yield* renderer.output.stdout(Buffer.from(h.canary.slice(8)));
          }),
        );
        switch (outcome) {
          case "error":
            return yield* Effect.fail(new Error(`failure ${h.canary}`));
          case "defect":
            return yield* Effect.die(new Error(`defect ${h.canary}`));
          case "interrupt":
            return yield* Effect.interrupt;
          case "success":
            return { value: h.canary };
          default:
            return outcome satisfies never;
        }
      }),
    );
    // When
    await runWithRendererHandling(effect, {
      runtime: h.runtime,
      io,
      rendererMode: "plain",
      resultSchema: ValueSchema,
      command: "test:redaction-finalizers",
      render: (value) => value.value,
      formatError: ({ error }) => String(error),
      setExitCode: () => undefined,
      deprecationWarnings: false,
    });
    // Then
    expect(io.stdout()).toContain("[redacted]");
    expect(io.stderr()).toContain("[redacted]");
    expect(io.stdout() + io.stderr()).not.toContain(h.canary);
  },
);

test("event subscribers, observer, query and buffered replay retain no resolved canary", async () => {
  // Given
  const h = fixture();
  const io = createBufferedRendererIO({ isTTY: false });
  const observed: string[] = [];
  const effect = Effect.scoped(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* (yield* Events.EventDispatchControl).install({
        hasSubscribers: () => true,
        dispatch: (event) =>
          Effect.sync(() => {
            observed.push(JSON.stringify(event));
          }),
      });
      const queue = yield* events.subscribeQueue;
      yield* h.resolve;
      yield* events.publish(MessageInfoEvent.make({ body: h.canary, timestamp: yield* DateTime.now }));
      observed.push(JSON.stringify(yield* Queue.take(queue)));
      observed.push(JSON.stringify(yield* events.query("*")));
      return { value: h.canary };
    }),
  ).pipe(
    Effect.provideService(Events.EventPublicationObserver, (event) =>
      Effect.sync(() => {
        observed.push(JSON.stringify(event));
      }),
    ),
  );
  // When
  await runWithRendererHandling(effect, {
    runtime: h.runtime,
    io,
    rendererMode: "plain",
    resultFormat: "json",
    streaming: StreamFrame,
    resultSchema: ValueSchema,
    command: "test:redaction-events",
    formatError: ({ error }) => String(error),
    setExitCode: () => undefined,
    deprecationWarnings: false,
  });
  // Then
  expect(observed).toHaveLength(4);
  expect(observed.every((text) => text.includes("[redacted]") && !text.includes(h.canary))).toBe(true);
  expect(io.stdout()).toContain("[redacted]");
  expect(io.stdout() + io.stderr()).not.toContain(h.canary);
});

test("real minimal bootstrap shares the invocation owner with buffered rendering", async () => {
  // Given
  const canary = "bootstrap-owner-late-canary";
  const io = createBufferedRendererIO({ isTTY: false });
  const runtime = makeLandoRuntime({ bootstrap: "minimal", telemetry: false, installSignalHandlers: false });
  const effect = Effect.gen(function* () {
    yield* (yield* RedactionService).registerValues([canary]);
    return { value: canary };
  });
  // When
  await runWithRendererHandling(effect, {
    runtime,
    io,
    rendererMode: "plain",
    resultFormat: "json",
    resultSchema: ValueSchema,
    command: "test:redaction-bootstrap",
    formatError: ({ error }) => String(error),
    setExitCode: () => undefined,
    deprecationWarnings: false,
  });
  // Then
  expect(JSON.parse(io.stdout()).result.value).toBe("[redacted]");
  expect(io.stdout() + io.stderr()).not.toContain(canary);
});
