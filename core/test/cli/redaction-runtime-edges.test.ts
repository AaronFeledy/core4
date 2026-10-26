import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Deferred, Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const Result = Schema.Struct({ value: Schema.String });

test("bootstrap failures retain registrations through diagnostic rendering", async () => {
  // Given
  const canary = "bootstrap-failure-runtime-canary";
  const runtime = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* (yield* RedactionService).registerValues([canary]);
      return yield* Effect.fail(new Error(`bootstrap ${canary}`));
    }),
  ).pipe(Layer.provide(RedactionService.layer));
  const io = createBufferedRendererIO({ isTTY: false });
  // When
  await runWithRendererHandling(Effect.succeed({ value: "unreachable" }), {
    runtime,
    io,
    rendererMode: "plain",
    resultFormat: "json",
    resultSchema: Result,
    command: "test:redaction-bootstrap-failure",
    formatError: ({ error }) => String(error),
    setExitCode: () => undefined,
    deprecationWarnings: false,
  });
  // Then
  expect(JSON.parse(io.stdout()).ok).toBe(false);
  expect(io.stdout()).toContain("[redacted]");
  expect(io.stdout() + io.stderr()).not.toContain(canary);
});

test("simultaneous CLI invocations mask only their own late registrations", async () => {
  // Given
  const ready = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const a = "invocation-a-private-canary";
  const b = "invocation-b-private-canary";
  const ioA = createBufferedRendererIO({ isTTY: false });
  const ioB = createBufferedRendererIO({ isTTY: false });
  const effectA = Effect.gen(function* () {
    yield* (yield* RedactionService).registerValues([a]);
    yield* Deferred.succeed(ready, undefined);
    yield* Deferred.await(release);
    return { value: `${a} ${b}` };
  });
  const effectB = Effect.gen(function* () {
    yield* Deferred.await(ready);
    yield* (yield* RedactionService).registerValues([b]);
    yield* Deferred.succeed(release, undefined);
    return { value: `${a} ${b}` };
  });
  // When
  await Promise.all([
    runWithRendererHandling(effectA, {
      runtime: RedactionService.layer,
      io: ioA,
      rendererMode: "plain",
      resultFormat: "json",
      resultSchema: Result,
      command: "test:redaction-a",
      formatError: ({ error }) => String(error),
      setExitCode: () => undefined,
      deprecationWarnings: false,
    }),
    runWithRendererHandling(effectB, {
      runtime: RedactionService.layer,
      io: ioB,
      rendererMode: "plain",
      resultFormat: "json",
      resultSchema: Result,
      command: "test:redaction-b",
      formatError: ({ error }) => String(error),
      setExitCode: () => undefined,
      deprecationWarnings: false,
    }),
  ]);
  // Then
  expect(JSON.parse(ioA.stdout()).result.value).toBe(`[redacted] ${b}`);
  expect(JSON.parse(ioB.stdout()).result.value).toBe(`${a} [redacted]`);
});

test("trace display and export finish before invocation redaction disposal", async () => {
  // Given
  const canary = "trace-late-runtime-canary";
  const io = createBufferedRendererIO({ isTTY: false });
  const effect = Effect.gen(function* () {
    yield* (yield* RedactionService).registerValues([canary]);
    yield* Effect.annotateCurrentSpan("diagnostic.value", canary);
    return { value: canary };
  });
  // When
  await runWithRendererHandling(effect, {
    runtime: RedactionService.layer,
    io,
    rendererMode: "plain",
    resultSchema: Result,
    render: (value) => value.value,
    command: "test:redaction-trace",
    trace: { enabled: true, display: true, headers: {}, env: {} },
    formatError: ({ error }) => String(error),
    setExitCode: () => undefined,
    deprecationWarnings: false,
  });
  // Then
  expect(io.stdout()).toContain("[redacted]");
  expect(io.stderr()).toContain("CommandLifecycle");
  expect(io.stdout() + io.stderr()).not.toContain(canary);
});
