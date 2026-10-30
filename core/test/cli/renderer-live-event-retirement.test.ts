import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createStdioRendererIO } from "@lando/renderer/io";
import { StreamFrame } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Deferred, Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { stalledOutput } from "./renderer-stalled-output";

const options = {
  rendererMode: "json",
  resultFormat: "json",
  streamingMode: "live",
  resultSchema: Schema.Struct({}),
  formatError: ({ error }: { readonly error: unknown }) => String(error),
  setExitCode: () => undefined,
} as const;
const publish = (body: string) =>
  Effect.flatMap(EventService, (events) =>
    events.publish({
      _tag: "message.info",
      body,
      timestamp: "2026-10-30T00:00:00.000Z",
    }),
  );

test("graceful retirement finishes a stalled event write and drains queued events before result", async () => {
  // Given
  const output = stalledOutput();
  const completed = Promise.withResolvers<void>();
  const runtime = Layer.effectDiscard(Effect.addFinalizer(() => publish("teardown").pipe(Effect.orDie))).pipe(
    Layer.provideMerge(LandoEventService.layer),
  );
  const io = createStdioRendererIO(output.stream, output.stream);
  let settled = false;
  // When: the first event is dequeued and blocked on stdout while the command completes.
  const running = runWithRendererHandling(
    Effect.gen(function* () {
      yield* publish("in flight");
      yield* Effect.promise(() => output.started);
      yield* publish("queued");
      completed.resolve();
      return {};
    }),
    { ...options, runtime, io },
  ).then(() => {
    settled = true;
  });
  try {
    await completed.promise;
    await new Promise<void>((done) => setImmediate(done));
    // Then: publication/completion did not block on the stalled consumer, but result must wait.
    expect(settled).toBe(false);
    expect(output.chunks.map((line) => JSON.parse(line)._tag)).toEqual(["event"]);
    output.release();
    await running;
    const frames = output.chunks.map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
    expect(frames.map((frame) => frame._tag)).toEqual(["event", "event", "result"]);
    expect(frames.filter((frame) => frame._tag === "event").map((frame) => frame.payload)).toMatchObject([
      { body: "in flight" },
      { body: "queued" },
    ]);
    expect(output.chunks.join("")).not.toContain("teardown");
  } finally {
    output.release();
    await running;
    output.stream.destroy();
  }
});

test("abort interrupts an event consumer stalled on stdout", async () => {
  // Given
  const output = stalledOutput();
  const controller = new AbortController();
  const stop = Effect.runSync(Deferred.make<void>());
  const exitCodes: number[] = [];
  let settled = false;
  const running = runWithRendererHandling(
    Effect.gen(function* () {
      yield* publish("in flight");
      yield* Deferred.await(stop);
      return {};
    }),
    {
      ...options,
      runtime: Layer.empty,
      signal: controller.signal,
      io: createStdioRendererIO(output.stream, output.stream),
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    },
  ).then(() => {
    settled = true;
  });
  try {
    await output.started;
    // When
    controller.abort("SIGINT");
    await new Promise<void>((done) => setImmediate(done));
    // Then: no drain signal is needed to retire the stalled worker.
    expect(settled).toBe(true);
    expect(output.chunks.map((line) => JSON.parse(line))).toMatchObject([
      { _tag: "event", event: "message.info" },
      { _tag: "result", envelope: { ok: false, error: { _tag: "CommandInterruptedError" } } },
    ]);
    expect(exitCodes).toEqual([130]);
    expect(output.stream.listenerCount("drain")).toBe(1);
  } finally {
    output.release();
    await Effect.runPromise(Deferred.succeed(stop, undefined));
    await running;
    output.stream.destroy();
  }
});

test("stdout closed before the bootstrap event exits 141 without a stack trace", async () => {
  // Given: a fresh process owns the process-lifetime broken-pipe policy.
  const script = `
    import { Effect, Layer } from "effect";
    import { EventService } from "@lando/sdk/services";
    import * as Events from "@lando/engine/services/event-service";
    import { installBrokenPipeExitPolicy } from "@lando/renderer/io";
    import { runWithRendererHandling } from "./core/src/cli/renderer-boundary.ts";
    installBrokenPipeExitPolicy();
    const runtime = Layer.effectDiscard(Effect.flatMap(EventService, events => events.publish({
      _tag: "message.info", body: "bootstrap", timestamp: "2026-10-30T00:00:00.000Z"
    }))).pipe(Layer.provideMerge(Events.layer));
    const timer = setTimeout(() => { process.stderr.write("consumer did not stop"); process.exit(90); }, 2000);
    await runWithRendererHandling(Effect.never, {
      runtime, rendererMode: "json", resultFormat: "json", streamingMode: "live",
      formatError: ({ error }) => String(error)
    });
    clearTimeout(timer);
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: resolve(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  // When
  await proc.stdout.cancel();
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  // Then
  expect(exitCode).toBe(141);
  expect(stderr).toBe("");
}, 10000);
