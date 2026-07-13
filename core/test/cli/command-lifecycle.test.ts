import { describe, expect, test } from "bun:test";

import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { StreamFrame } from "@lando/sdk/schema";
import { EventService, type EventServiceShape, type LandoEvent, Logger } from "@lando/sdk/services";

import {
  type RunWithRendererHandlingOptions,
  runWithRendererHandling,
} from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { StreamFrameSink } from "../../src/cli/stream-frame-sink.ts";

class CommandLifecycleTestError extends Schema.TaggedError<CommandLifecycleTestError>()(
  "CommandLifecycleTestError",
  { message: Schema.String },
) {}

const canonicalInvocation = {
  commandId: "app:start",
  argv: ["start", "--service", "appserver"],
  args: { service: "appserver" },
  flags: { verbose: true },
  cwd: "/workspace/demo",
  app: { kind: "user", id: "demo", root: "/workspace/demo" },
} as const;

type CliInvocation = {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly args: Readonly<Record<string, string>>;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly cwd: string;
  readonly app?: {
    readonly kind: "user" | "global" | "scratch";
    readonly id: string;
    readonly root: string;
  };
};

type LifecycleOptions<A, R, RE> = RunWithRendererHandlingOptions<A, R, RE> & {
  readonly invocation: CliInvocation;
};

type RecordingHarness = {
  readonly events: Array<LandoEvent>;
  readonly exitCodes: Array<number>;
  readonly layer: Layer.Layer<EventService>;
};

const makeRecordingHarness = (ordering?: Array<string>, failPublish = false): RecordingHarness => {
  const events: Array<LandoEvent> = [];
  const exitCodes: Array<number> = [];
  const service: EventServiceShape = {
    publish: (event) =>
      failPublish
        ? Effect.die("event subscriber failed")
        : Effect.sync(() => {
            events.push(event);
            ordering?.push(event._tag);
          }),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<LandoEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return queue;
    }),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  };
  return {
    events,
    exitCodes,
    layer: Layer.succeed(EventService, service),
  };
};

const optionsFor = <A>(
  harness: RecordingHarness,
  invocation: CliInvocation = canonicalInvocation,
): LifecycleOptions<A, EventService, never> => ({
  runtime: harness.layer,
  rendererMode: "plain",
  command: invocation.commandId,
  invocation,
  io: createBufferedRendererIO(),
  render: () => undefined,
  formatError: (error) => String(error),
  setExitCode: (code) => {
    harness.exitCodes.push(code);
  },
});

describe("generic CLI command lifecycle", () => {
  test("orders canonical init, command-specific, and canonical run events", async () => {
    // Given
    const harness = makeRecordingHarness();
    const command = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish({ _tag: "post-start", marker: "specific" });
      return "started";
    });

    // When
    await runWithRendererHandling(command, optionsFor<string>(harness));

    // Then
    expect(harness.events.map((event) => event._tag)).toEqual([
      "cli-app:start-init",
      "post-start",
      "cli-app:start-run",
    ]);
  });

  test("keeps canonical identity when argv contains a top-level alias", async () => {
    // Given
    const harness = makeRecordingHarness();

    // When
    await runWithRendererHandling(Effect.succeed("started"), optionsFor<string>(harness));

    // Then
    expect(harness.events).toEqual([
      expect.objectContaining({
        _tag: "cli-app:start-init",
        commandId: "app:start",
        argv: ["[redacted]", "--service", "[redacted]"],
        args: { service: "[redacted]" },
        flags: { verbose: true },
        cwd: "/workspace/demo",
        app: { kind: "user", id: "demo", root: "/workspace/demo" },
      }),
      expect.objectContaining({ _tag: "cli-app:start-run", commandId: "app:start" }),
    ]);
  });

  test("publishes exit code and duration on successful completion", async () => {
    // Given
    const harness = makeRecordingHarness();

    // When
    await runWithRendererHandling(Effect.succeed("started"), optionsFor<string>(harness));

    // Then
    expect(harness.events.at(-1)).toMatchObject({
      _tag: "cli-app:start-run",
      exitCode: 0,
      durationMs: expect.any(Number),
    });
  });

  for (const scenario of [
    {
      name: "tagged failure",
      effect: Effect.fail(new CommandLifecycleTestError({ message: "provider unavailable" })),
      failureTag: "CommandLifecycleTestError",
    },
    { name: "defect", effect: Effect.die(new Error("unexpected defect")), failureTag: "Defect" },
    { name: "interruption", effect: Effect.interrupt, failureTag: "Interrupted" },
  ]) {
    test(`publishes one terminal error for ${scenario.name}`, async () => {
      // Given
      const harness = makeRecordingHarness();

      // When
      await runWithRendererHandling(scenario.effect, optionsFor<never>(harness));

      // Then
      expect(harness.events).toEqual([
        expect.objectContaining({ _tag: "cli-app:start-init" }),
        expect.objectContaining({
          _tag: "cli-app:start-error",
          failureTag: scenario.failureTag,
          exitCode: 1,
          durationMs: expect.any(Number),
        }),
      ]);
    });
  }

  test("reports a graceful interruption with the preserved zero exit code", async () => {
    const harness = makeRecordingHarness();
    const options = {
      ...optionsFor<never>(harness),
      suppressInterruptionDiagnostics: true,
    };

    await runWithRendererHandling(Effect.interrupt, options);

    expect(harness.events.at(-1)).toMatchObject({
      _tag: "cli-app:start-error",
      failureTag: "Interrupted",
      exitCode: 0,
    });
    expect(harness.exitCodes).toEqual([]);
  });

  test("publishes the terminal lifecycle event before scope finalizers", async () => {
    const ordering: Array<string> = [];
    const harness = makeRecordingHarness(ordering);
    const finalizerLayer = Layer.scopedDiscard(
      Effect.addFinalizer(() => Effect.sync(() => ordering.push("finalizer"))),
    );
    const options = {
      ...optionsFor<string>(harness),
      runtime: Layer.merge(harness.layer, finalizerLayer),
    };

    await runWithRendererHandling(Effect.succeed("started"), options);

    expect(ordering).toEqual(["cli-app:start-init", "cli-app:start-run", "finalizer"]);
  });

  test("redacts invocation metadata before live publication", async () => {
    // Given
    const secret = "lifecycle-secret-value";
    const previous = process.env.BUN_AUTH_TOKEN;
    process.env.BUN_AUTH_TOKEN = secret;
    const harness = makeRecordingHarness();
    const invocation: CliInvocation = {
      ...canonicalInvocation,
      argv: ["start", `--token=${secret}`],
      args: { token: secret },
      flags: { token: secret },
    };

    // When
    try {
      await runWithRendererHandling(Effect.succeed("started"), optionsFor<string>(harness, invocation));
    } finally {
      process.env.BUN_AUTH_TOKEN = previous;
    }

    // Then
    expect(JSON.stringify(harness.events)).not.toContain(secret);
    expect(JSON.stringify(harness.events)).toContain("[redacted]");
  });

  test("publishes invocation summaries without separated secrets or passthrough tails", async () => {
    // Given
    const harness = makeRecordingHarness();
    const invocation: CliInvocation = {
      ...canonicalInvocation,
      argv: ["start", "--service", "appserver", "--token", "s3cr3t", "--", "hunter2"],
    };

    // When
    await runWithRendererHandling(
      Effect.fail(new CommandLifecycleTestError({ message: "provider unavailable" })),
      optionsFor<never>(harness, invocation),
    );

    // Then
    const serialized = JSON.stringify(harness.events);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("appserver");
  });

  test("does not publish failure messages that can echo unknown secrets", async () => {
    const harness = makeRecordingHarness();

    await runWithRendererHandling(
      Effect.fail(new CommandLifecycleTestError({ message: "rejected unknown-secret-value" })),
      optionsFor<never>(harness),
    );

    expect(JSON.stringify(harness.events)).not.toContain("unknown-secret-value");
    expect(harness.events.at(-1)).toMatchObject({ failureTag: "CommandLifecycleTestError" });
  });

  test("preserves command success when lifecycle publication fails", async () => {
    // Given
    const harness = makeRecordingHarness(undefined, true);
    const rendered: Array<string> = [];

    // When
    await runWithRendererHandling(Effect.succeed("started"), {
      ...optionsFor<string>(harness),
      render: (value) => {
        rendered.push(value);
        return undefined;
      },
    });

    // Then
    expect(rendered).toEqual(["started"]);
    expect(harness.exitCodes).toEqual([]);
  });

  test("logs lifecycle publication failures at debug without changing command success", async () => {
    const harness = makeRecordingHarness(undefined, true);
    const debugMessages: string[] = [];
    const logger = {
      debug: (message: string) => Effect.sync(() => debugMessages.push(message)),
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
    };

    await runWithRendererHandling(Effect.succeed("started"), {
      ...optionsFor<string>(harness),
      runtime: Layer.merge(harness.layer, Layer.succeed(Logger, logger)),
    });

    expect(debugMessages).toEqual([
      "CLI lifecycle event publication failed.",
      "CLI lifecycle event publication failed.",
    ]);
    expect(harness.exitCodes).toEqual([]);
  });

  test("uses an internal event service for Layer.empty bootstrap-none commands", async () => {
    // Given
    const io = createBufferedRendererIO();
    const options = {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "meta:version",
      invocation: {
        commandId: "meta:version",
        argv: ["version"],
        args: {},
        flags: {},
        cwd: "/workspace/demo",
      },
      io,
      streaming: StreamFrame,
      resultSchema: Schema.Struct({ version: Schema.String }),
      render: () => undefined,
      formatError: (error: unknown) => String(error),
    } satisfies LifecycleOptions<{ readonly version: string }, never, never>;

    // When
    await runWithRendererHandling(Effect.succeed({ version: "4.0.0" }), options);

    // Then
    const frames = io.stdoutLines().map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
    expect(frames.flatMap((frame) => (frame._tag === "event" ? [frame.event] : []))).toEqual([
      "cli-meta:version-init",
      "cli-meta:version-run",
    ]);
  });

  test("publishes the run event before a live stream terminal result", async () => {
    // Given
    const ordering: Array<string> = [];
    const harness = makeRecordingHarness(ordering);
    const io = {
      writeStdout: (chunk: string) => {
        ordering.push(chunk.includes('"_tag":"result"') ? "result-frame" : "stream-frame");
      },
      writeStderr: () => undefined,
    };
    const options = {
      ...optionsFor<{ readonly ok: boolean }>(harness),
      rendererMode: "json",
      resultFormat: "json",
      streamingMode: "live",
      resultSchema: Schema.Struct({ ok: Schema.Boolean }),
      io,
    } satisfies LifecycleOptions<{ readonly ok: boolean }, EventService | StreamFrameSink, never>;
    const command = Effect.gen(function* () {
      const sink = yield* StreamFrameSink;
      yield* sink.emit({ _tag: "stdout", chunk: "working" });
      return { ok: true };
    });

    // When
    await runWithRendererHandling(command, options);

    // Then
    expect(ordering).toEqual(["cli-app:start-init", "stream-frame", "cli-app:start-run", "result-frame"]);
  });
});
