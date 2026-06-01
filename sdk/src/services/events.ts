import { Context, type Effect, type Queue, type Scope, type Stream } from "effect";

import type { EventError } from "../errors/index.ts";

export interface LandoEvent {
  readonly _tag: string;
  readonly [key: string]: unknown;
}

export class EventService extends Context.Tag("@lando/core/EventService")<
  EventService,
  {
    readonly publish: (event: LandoEvent) => Effect.Effect<void, EventError>;
    readonly subscribe: (name: string) => Stream.Stream<LandoEvent, EventError>;
    /**
     * Eagerly acquires a `PubSub` subscription queue in the caller's `Scope`
     * so consumers that need the first event must use it instead of the lazy
     * `subscribe` stream.
     */
    readonly subscribeQueue: Effect.Effect<Queue.Dequeue<LandoEvent>, never, Scope.Scope>;
    readonly waitFor: (
      name: string,
      filter?: (event: LandoEvent) => boolean,
    ) => Effect.Effect<LandoEvent, EventError>;
  }
>() {}

/**
 * Logger — structured logging through Effect.
 *
 * Replaceable; default is Effect's Logger.pretty (TTY) / Logger.json (non-TTY).
 *
 * Note: the actual Effect logger contract is `Logger.Logger<Message, Output>`.
 * This tag is the *Lando* logger service — a thin wrapper that selects which
 * Effect Logger configuration to install.
 */
export class Logger extends Context.Tag("@lando/core/Logger")<
  Logger,
  {
    readonly debug: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
    readonly info: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
    readonly warn: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
    readonly error: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
  }
>() {}
