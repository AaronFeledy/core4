import { Effect } from "effect";
import type { Scope } from "effect";

import { type EventError, PluginLoadError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import type { LandoPluginContext } from "../plugins/context.ts";

import type { IndexedSubscriber } from "./subscriber-index.ts";

export type RuntimeSubscriberHandler = (event: LandoEvent) => Effect.Effect<void, EventError>;
export type RuntimeSubscriberFactory = (
  context: LandoPluginContext,
  config: unknown,
) => RuntimeSubscriberHandler;

type SubscriberModule = { readonly default?: unknown };

const loadError = (subscriber: IndexedSubscriber, message: string, cause?: unknown): PluginLoadError =>
  new PluginLoadError({
    pluginName: subscriber.pluginName,
    message: cause === undefined ? message : `${message}: ${String(cause)}`,
  });

export const isRuntimeSubscriberFactory = (value: unknown): value is RuntimeSubscriberFactory =>
  typeof value === "function";

export const loadExternalSubscriberFactory = (
  subscriber: IndexedSubscriber,
): Effect.Effect<RuntimeSubscriberFactory, PluginLoadError> =>
  Effect.tryPromise({
    try: () => import(subscriber.entry.module).then((module: SubscriberModule) => module),
    catch: (cause) =>
      loadError(subscriber, `Failed to import subscriber module ${subscriber.entry.module}`, cause),
  }).pipe(
    Effect.flatMap((module) =>
      isRuntimeSubscriberFactory(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(
            loadError(subscriber, `Subscriber module ${subscriber.entry.module} has no default factory.`),
          ),
    ),
  );

export const makeCachedSubscriberHandler = (
  load: Effect.Effect<RuntimeSubscriberFactory, PluginLoadError>,
  context: LandoPluginContext,
  config: unknown,
): Effect.Effect<Effect.Effect<RuntimeSubscriberHandler, PluginLoadError>, never, Scope.Scope> =>
  Effect.cached(Effect.map(load, (factory) => factory(context, config)));
