import { Context, type Duration, type Effect, type Queue, type Scope, type Stream } from "effect";

import type { EventError } from "../errors/index.ts";
import type { LandoEvent as KnownLandoEvent } from "../events/union.ts";

export interface LandoEvent {
  readonly _tag: string;
  readonly [key: string]: unknown;
}

export type LandoEventName = KnownLandoEvent["_tag"];

/**
 * Narrows an event by its subscription `name`: `"*"` resolves to the full
 * canonical union, a known `_tag` literal resolves to that variant, and any
 * other string falls back to the loose structural `LandoEvent` so existing
 * `subscribe(name: string)` callers keep compiling unchanged.
 */
export type EventFor<Name extends string> = Name extends "*"
  ? KnownLandoEvent
  : Name extends LandoEventName
    ? Extract<KnownLandoEvent, { readonly _tag: Name }>
    : LandoEvent;

export interface EventWaitOptions<Name extends string> {
  readonly filter?: (event: EventFor<Name>) => boolean;
  readonly timeout?: Duration.DurationInput;
}

export interface EventWaitAnyOptions {
  readonly timeout?: Duration.DurationInput;
}

export interface EventWaitSpec<Name extends string = string> {
  readonly name: Name;
  readonly filter?: (event: EventFor<Name>) => boolean;
}

export type EventWaitSpecs<Names extends readonly string[]> = {
  readonly [Index in keyof Names]: EventWaitSpec<Names[Index] & string>;
};

export interface EventServiceShape {
  readonly publish: (event: LandoEvent) => Effect.Effect<void, EventError>;
  readonly subscribe: <Name extends string>(name: Name) => Stream.Stream<EventFor<Name>, EventError>;
  /**
   * Eagerly acquires a `PubSub` subscription queue in the caller's `Scope`
   * so consumers that need the first event must use it instead of the lazy
   * `subscribe` stream.
   */
  readonly subscribeQueue: Effect.Effect<Queue.Dequeue<LandoEvent>, never, Scope.Scope>;
  /**
   * Resolves with the first event named `name` (matching `filter`) from the
   * live stream. With `timeout`, fails `EventError({ reason: "timeout" })`
   * when the deadline elapses (driven through Effect `Clock`); without
   * `timeout` it waits indefinitely.
   */
  readonly waitFor: <Name extends string>(
    name: Name,
    options?: EventWaitOptions<Name>,
  ) => Effect.Effect<EventFor<Name>, EventError>;
  /**
   * Resolves with the first event matching any of `specs` under the same
   * timeout contract as {@link EventServiceShape.waitFor}.
   */
  readonly waitForAny: <const Names extends readonly string[]>(
    specs: EventWaitSpecs<Names>,
    options?: EventWaitAnyOptions,
  ) => Effect.Effect<EventFor<Names[number] & string>, EventError>;
  /**
   * Scans the bounded in-memory history buffer (redacted before buffering)
   * and returns matching events without blocking. Events evicted from the
   * buffer are never returned; a `cap: 0` host always returns `[]`.
   */
  readonly query: <Name extends string>(
    name: Name,
    filter?: (event: EventFor<Name>) => boolean,
  ) => Effect.Effect<ReadonlyArray<EventFor<Name>>, never>;
}

export class EventService extends Context.Tag("@lando/core/EventService")<
  EventService,
  EventServiceShape
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
