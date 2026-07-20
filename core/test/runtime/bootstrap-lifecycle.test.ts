import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Queue, Stream } from "effect";

import { EventError } from "@lando/sdk/errors";
import { type EventFor, EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";

import {
  makeBootstrapLifecycleTracker,
  superviseBootstrapLayer,
} from "../../src/runtime/bootstrap-lifecycle.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { makeEventServiceLive } from "../../src/services/event-service.ts";

const stubEventService = (
  publish: (event: LandoEvent) => Effect.Effect<void, EventError>,
): EventServiceShape => ({
  publish,
  subscribe: () => Stream.empty,
  subscribeQueue: Effect.gen(function* () {
    const queue = yield* Queue.unbounded<LandoEvent>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return queue;
  }),
  waitFor: () => Effect.never,
  waitForAny: () => Effect.never,
  query: <Name extends string>() => Effect.succeed<ReadonlyArray<EventFor<Name>>>([]),
});

const makeRecordingEventLayer = (tags: string[]): Layer.Layer<EventService> =>
  Layer.succeed(
    EventService,
    stubEventService((event) => Effect.sync(() => tags.push(event._tag))),
  );

describe("runtime bootstrap lifecycle", () => {
  test("emits the app bootstrap sequence and before-exit before host finalizers", async () => {
    const ordering: string[] = [];
    const hostFinalizer = Layer.scopedDiscard(
      Effect.addFinalizer(() => Effect.sync(() => ordering.push("host-finalizer"))),
    );

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          makeLandoRuntime({
            bootstrap: "app",
            plugins: { layers: [makeRecordingEventLayer(ordering), hostFinalizer] },
          }),
        ),
      ),
    );

    expect(ordering).toEqual([
      "pre-bootstrap-minimal",
      "post-bootstrap-minimal",
      "pre-bootstrap-plugins",
      "post-bootstrap-plugins",
      "pre-bootstrap-commands",
      "post-bootstrap-commands",
      "pre-bootstrap-provider",
      "post-bootstrap-provider",
      "pre-bootstrap-app",
      "post-bootstrap-app",
      "post-bootstrap",
      "ready",
      "before-exit",
      "host-finalizer",
    ]);
  });

  test("minimal bootstrap uses the zero-subscriber short-circuit", async () => {
    let decodeCalls = 0;
    let pubSubCalls = 0;
    const eventLayer = makeEventServiceLive(16, {
      onPayloadDecode: () => {
        decodeCalls += 1;
      },
      onPubSubPublish: () => {
        pubSubCalls += 1;
      },
    });

    const history = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({ bootstrap: "minimal", plugins: { layers: [eventLayer] } }),
          );
          return yield* Context.get(context, EventService).query("*");
        }),
      ),
    );

    expect(history.map((event) => event._tag)).toEqual([
      "pre-bootstrap-minimal",
      "post-bootstrap-minimal",
      "post-bootstrap",
      "ready",
    ]);
    expect(decodeCalls).toBe(0);
    expect(pubSubCalls).toBe(0);
  });

  test("partial bootstrap failure emits completed levels and before-exit", async () => {
    const ordering: string[] = [];
    const tracker = makeBootstrapLifecycleTracker();
    const events = Context.get(
      await Effect.runPromise(Layer.build(makeRecordingEventLayer(ordering)).pipe(Effect.scoped)),
      EventService,
    );
    await Effect.runPromise(tracker.complete("minimal", events));
    await Effect.runPromise(tracker.complete("plugins", events));
    const failingResource = Layer.fail("plugin bootstrap failed");

    await Effect.runPromiseExit(
      Layer.build(superviseBootstrapLayer(failingResource, tracker)).pipe(Effect.scoped),
    );

    expect(ordering).toEqual([
      "pre-bootstrap-minimal",
      "post-bootstrap-minimal",
      "pre-bootstrap-plugins",
      "post-bootstrap-plugins",
      "before-exit",
    ]);
  });

  test("bootstrap publication failure reports exit code one before unwinding", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const events: LandoEvent[] = [];
    const service = stubEventService((event) => {
      events.push(event);
      return event._tag === "before-exit"
        ? Effect.void
        : Effect.fail(new EventError({ event: event._tag, message: "subscriber rejected bootstrap" }));
    });
    const tracker = makeBootstrapLifecycleTracker();
    await Effect.runPromise(tracker.complete("minimal", service));

    try {
      await Effect.runPromiseExit(
        Layer.build(superviseBootstrapLayer(Layer.succeed(EventService, service), tracker)).pipe(
          Effect.scoped,
        ),
      );
    } finally {
      process.exitCode = previousExitCode;
    }

    expect(events.at(-1)).toMatchObject({ _tag: "before-exit", exitCode: 1 });
  });

  test("event service acquisition emits before-exit when minimal does not complete", async () => {
    const events: string[] = [];
    const serviceLayer = makeRecordingEventLayer(events);
    const service = Context.get(
      await Effect.runPromise(Layer.build(serviceLayer).pipe(Effect.scoped)),
      EventService,
    );
    const tracker = makeBootstrapLifecycleTracker();
    await Effect.runPromise(tracker.useBaseEventService(service));

    await Effect.runPromiseExit(
      Layer.build(superviseBootstrapLayer(Layer.fail("minimal bootstrap failed"), tracker)).pipe(
        Effect.scoped,
      ),
    );

    expect(events).toEqual(["before-exit"]);
  });

  test("partial failure publishes through an acquired host EventService override", async () => {
    const hostEvents: string[] = [];
    const runtime = makeLandoRuntime({
      bootstrap: "minimal",
      plugins: {
        layers: [
          makeRecordingEventLayer(hostEvents),
          Layer.effect(
            EventService,
            Effect.fail(new EventError({ event: "bootstrap", message: "host bootstrap failed" })),
          ),
        ],
      },
    });

    await Effect.runPromiseExit(Layer.build(runtime).pipe(Effect.scoped));

    expect(hostEvents).toEqual(["pre-bootstrap-minimal", "post-bootstrap-minimal", "before-exit"]);
  });

  test("partial failure emits before-exit when completed-level publication aborts", async () => {
    const events: LandoEvent[] = [];
    const service = stubEventService((event) => {
      events.push(event);
      return event._tag === "before-exit"
        ? Effect.void
        : Effect.fail(new EventError({ event: event._tag, message: "subscriber aborted bootstrap" }));
    });
    const tracker = makeBootstrapLifecycleTracker();
    await Effect.runPromise(tracker.complete("minimal", service));

    await Effect.runPromiseExit(
      Layer.build(superviseBootstrapLayer(Layer.fail("plugin bootstrap failed"), tracker)).pipe(
        Effect.scoped,
      ),
    );

    expect(events.map((event) => event._tag)).toEqual(["pre-bootstrap-minimal", "before-exit"]);
    expect(events.at(-1)).toMatchObject({ exitCode: 1 });
  });
});
