import { Clock, DateTime, Effect, Exit, Layer, Scope } from "effect";

import type { EventError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { EventServiceShape, LandoEvent } from "@lando/sdk/services";

import { bootstrapError } from "./runtime-options.ts";

export type BootstrapEventLevel = "minimal" | "plugins" | "commands" | "tooling" | "provider" | "app";
type BootstrapEventTag =
  | `pre-bootstrap-${BootstrapEventLevel}`
  | `post-bootstrap-${BootstrapEventLevel}`
  | "post-bootstrap"
  | "ready";

export interface BootstrapLifecycleTracker {
  readonly complete: (level: BootstrapEventLevel, events: EventServiceShape) => Effect.Effect<void>;
  readonly completedLevels: () => ReadonlyArray<BootstrapEventLevel>;
  readonly eventService: () => EventServiceShape | undefined;
  readonly useBaseEventService: (events: EventServiceShape) => Effect.Effect<void>;
  readonly useEventService: (events: EventServiceShape) => Effect.Effect<void>;
}

export const makeBootstrapLifecycleTracker = (): BootstrapLifecycleTracker => {
  const completedLevels: BootstrapEventLevel[] = [];
  let baseEventService: EventServiceShape | undefined;
  let effectiveEventService: EventServiceShape | undefined;
  return {
    complete: (level, events) =>
      Effect.sync(() => {
        if (!completedLevels.includes(level)) completedLevels.push(level);
        baseEventService = events;
      }),
    completedLevels: () => completedLevels,
    eventService: () => effectiveEventService ?? baseEventService,
    useBaseEventService: (events) =>
      Effect.sync(() => {
        baseEventService = events;
      }),
    useEventService: (events) =>
      Effect.sync(() => {
        effectiveEventService = events;
      }),
  };
};

const timestampedEvent = (tag: BootstrapEventTag, timestamp: DateTime.Utc): LandoEvent => {
  switch (tag) {
    case "pre-bootstrap-minimal":
      return { _tag: "pre-bootstrap-minimal", timestamp };
    case "post-bootstrap-minimal":
      return { _tag: "post-bootstrap-minimal", timestamp };
    case "pre-bootstrap-plugins":
      return { _tag: "pre-bootstrap-plugins", timestamp };
    case "post-bootstrap-plugins":
      return { _tag: "post-bootstrap-plugins", timestamp };
    case "pre-bootstrap-commands":
      return { _tag: "pre-bootstrap-commands", timestamp };
    case "post-bootstrap-commands":
      return { _tag: "post-bootstrap-commands", timestamp };
    case "pre-bootstrap-tooling":
      return { _tag: "pre-bootstrap-tooling", timestamp };
    case "post-bootstrap-tooling":
      return { _tag: "post-bootstrap-tooling", timestamp };
    case "pre-bootstrap-provider":
      return { _tag: "pre-bootstrap-provider", timestamp };
    case "post-bootstrap-provider":
      return { _tag: "post-bootstrap-provider", timestamp };
    case "pre-bootstrap-app":
      return { _tag: "pre-bootstrap-app", timestamp };
    case "post-bootstrap-app":
      return { _tag: "post-bootstrap-app", timestamp };
    case "post-bootstrap":
      return { _tag: "post-bootstrap", timestamp };
    case "ready":
      return { _tag: "ready", timestamp };
  }
};

const publishTimestamped = (events: EventServiceShape, tag: BootstrapEventTag) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => events.publish(timestampedEvent(tag, DateTime.unsafeMake(now)))),
  );

const publishCompletedLevels = (
  events: EventServiceShape,
  levels: ReadonlyArray<BootstrapEventLevel>,
): Effect.Effect<void, EventError> =>
  Effect.forEach(
    levels,
    (level) =>
      publishTimestamped(events, `pre-bootstrap-${level}`).pipe(
        Effect.zipRight(publishTimestamped(events, `post-bootstrap-${level}`)),
      ),
    { discard: true },
  );

const publishBeforeExit = (events: EventServiceShape, exitCode: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      events.publish({
        _tag: "before-exit",
        exitCode,
        timestamp: DateTime.unsafeMake(now),
      }),
    ),
  );

const publishBootstrapFailure = (tracker: BootstrapLifecycleTracker): Effect.Effect<void> => {
  const events = tracker.eventService();
  if (events === undefined) return Effect.void;
  return publishCompletedLevels(events, tracker.completedLevels()).pipe(
    Effect.catchAllCause(() => Effect.void),
    Effect.zipRight(publishBeforeExit(events, 1).pipe(Effect.catchAllCause(() => Effect.void))),
  );
};

export const superviseBootstrapLayer = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  tracker: BootstrapLifecycleTracker,
): Layer.Layer<A, E | LandoRuntimeBootstrapError, R> =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.make();
      const runtimeExit = yield* Layer.buildWithScope(Layer.extendScope(layer), runtimeScope).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.exit,
      );
      if (Exit.isFailure(runtimeExit)) {
        yield* publishBootstrapFailure(tracker);
        yield* Scope.close(runtimeScope, runtimeExit);
        return yield* Effect.failCause(runtimeExit.cause);
      }

      const events = tracker.eventService();
      if (events === undefined) {
        yield* Scope.close(runtimeScope, Exit.void);
        return yield* Effect.fail(
          bootstrapError("Bootstrap lifecycle event service was unavailable.", undefined),
        );
      }
      let publicationFailed = false;
      yield* Effect.addFinalizer((scopeExit) =>
        publishBeforeExit(
          events,
          publicationFailed ? 1 : typeof process.exitCode === "number" ? process.exitCode : 0,
        ).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.ensuring(Scope.close(runtimeScope, scopeExit)),
        ),
      );
      yield* publishCompletedLevels(events, tracker.completedLevels()).pipe(
        Effect.zipRight(publishTimestamped(events, "post-bootstrap")),
        Effect.zipRight(publishTimestamped(events, "ready")),
        Effect.tapError(() =>
          Effect.sync(() => {
            publicationFailed = true;
          }),
        ),
        Effect.mapError((cause) => bootstrapError("Failed to publish bootstrap lifecycle events.", cause)),
      );
      return Layer.succeedContext(runtimeExit.value);
    }),
  );
