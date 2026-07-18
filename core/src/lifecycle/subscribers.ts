import { type Context, Effect, Layer, Schema } from "effect";

import { EventError, PluginLoadError } from "@lando/sdk/errors";
import { LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import type { LandoEvent } from "@lando/sdk/events";
import { AbsolutePath, type NotifyConfig, type PluginManifest } from "@lando/sdk/schema";
import {
  CommandRegistry,
  ConfigService,
  EventService,
  Logger,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  type RegisteredCommand,
  StateStore,
} from "@lando/sdk/services";

import { COMPILED_OCLIF_MANIFEST } from "../cli/oclif/compiled-manifest.ts";
import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import { makeLandoPluginContext } from "../plugins/context.ts";
import { RedactionService } from "../redaction/service.ts";
import { EventDispatchControl } from "../services/event-service.ts";
import { makePublishRender } from "./publish-render.ts";
import { resolveNotifyConfig } from "./subscriber-config.ts";
import type { IndexedSubscriber } from "./subscriber-index.ts";
import { makeSubscriberRegistrationClosure } from "./subscriber-index.ts";
import {
  type RuntimeSubscriberFactory,
  type RuntimeSubscriberHandler,
  isRuntimeSubscriberFactory,
  loadExternalSubscriberFactory,
  makeCachedSubscriberHandler,
} from "./subscriber-loader.ts";

const contributionId = (entry: string | { readonly id: string }): string =>
  typeof entry === "string" ? entry : entry.id;

export const canonicalSubscriberCommandIds = (
  manifests: ReadonlyArray<PluginManifest>,
  commands: ReadonlyArray<RegisteredCommand> = [],
): ReadonlyArray<string> => {
  const ids = new Set(Object.values(COMPILED_OCLIF_MANIFEST.commands).map((entry) => entry.id));
  for (const manifest of manifests) {
    for (const command of manifest.contributes?.commands ?? []) ids.add(contributionId(command));
  }
  for (const command of commands) ids.add(command.id);
  return [...ids];
};

const loadFactory = (
  subscriber: IndexedSubscriber,
): Effect.Effect<RuntimeSubscriberFactory, PluginLoadError> => {
  if (subscriber.entry.module.startsWith("file://")) {
    return loadExternalSubscriberFactory(subscriber);
  }
  const bundled = BUNDLED_PLUGINS.find((plugin) => plugin.name === subscriber.pluginName);
  if (bundled === undefined) return loadExternalSubscriberFactory(subscriber);
  const loader = bundled.subscriberFactoryLoaders?.get(subscriber.entry.id);
  if (loader === undefined) {
    return Effect.fail(
      new PluginLoadError({
        pluginName: subscriber.pluginName,
        message: `Bundled subscriber factory ${subscriber.entry.id} is not registered.`,
      }),
    );
  }
  return Effect.tryPromise({
    try: loader,
    catch: (cause) =>
      new PluginLoadError({
        pluginName: subscriber.pluginName,
        message: `Bundled subscriber factory ${subscriber.entry.id} failed to load: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((factory) =>
      isRuntimeSubscriberFactory(factory)
        ? Effect.succeed(factory)
        : Effect.fail(
            new PluginLoadError({
              pluginName: subscriber.pluginName,
              message: `Bundled subscriber factory ${subscriber.entry.id} did not export a factory.`,
            }),
          ),
    ),
  );
};

const projectedConfig = (subscriber: IndexedSubscriber, notify: NotifyConfig | undefined): unknown => {
  switch (subscriber.entry.configKey) {
    case undefined:
      return undefined;
    case "notify":
      return notify;
  }
};

type DispatchEntry = {
  readonly event: LandoEvent;
  readonly subscriber: IndexedSubscriber;
  readonly getHandler: Effect.Effect<RuntimeSubscriberHandler, PluginLoadError>;
  readonly logger: Context.Tag.Service<typeof Logger>;
};

const subscriberEventError = (
  input: Pick<DispatchEntry, "event" | "subscriber">,
  cause: unknown,
): EventError =>
  new EventError({
    event: input.event._tag,
    message: `Subscriber ${input.subscriber.pluginName}/${input.subscriber.entry.id} failed to load.`,
    cause,
  });

const dispatchEntry = (input: DispatchEntry): Effect.Effect<void, EventError> => {
  const run = input.getHandler.pipe(
    Effect.mapError((cause) => subscriberEventError(input, cause)),
    Effect.flatMap((handler) => handler(input.event)),
  );
  if (input.event._tag.startsWith("pre-")) return run;
  if (input.event._tag.startsWith("post-") && input.subscriber.entry.abortOnError) return run;
  if (input.event._tag.startsWith("cli-")) {
    return run.pipe(
      Effect.catchAll((cause) =>
        input.logger
          .debug("CLI lifecycle subscriber failed.", { subscriber: input.subscriber.entry.id, cause })
          .pipe(Effect.catchAll(() => Effect.void)),
      ),
    );
  }
  return run.pipe(
    Effect.catchAll((cause) =>
      input.logger
        .warn("Lifecycle subscriber failed.", { subscriber: input.subscriber.entry.id, cause })
        .pipe(Effect.catchAll(() => Effect.void)),
    ),
  );
};

export const makeSubscriberRuntimeLive = () =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const plugins = yield* PluginRegistry;
      const configService = yield* ConfigService;
      const events = yield* EventService;
      const dispatchControl = yield* EventDispatchControl;
      const logger = yield* Logger;
      const managedFiles = yield* ManagedFileService;
      const stateStore = yield* StateStore;
      const paths = yield* PathsService;
      const redaction = yield* RedactionService;
      const manifests = yield* plugins.list;
      const commandRegistry = yield* CommandRegistry;
      const resolvedCommands = yield* commandRegistry.list;
      const commandIds = canonicalSubscriberCommandIds(manifests, resolvedCommands);
      const notifyCommandIds = new Set(commandIds);
      const hasNotifySubscriber = manifests.some((manifest) =>
        manifest.subscribers?.some((subscriber) => subscriber.configKey === "notify"),
      );
      const notify = hasNotifySubscriber
        ? yield* resolveNotifyConfig(yield* configService.load, notifyCommandIds)
        : undefined;
      const closure = makeSubscriberRegistrationClosure(manifests);
      const index = yield* closure.close(commandIds);
      const handlers = new Map<IndexedSubscriber, Effect.Effect<RuntimeSubscriberHandler, PluginLoadError>>();
      for (const entries of index.values()) {
        for (const subscriber of entries) {
          if (handlers.has(subscriber)) continue;
          const pluginStateRoot = yield* Schema.decodeUnknown(AbsolutePath)(
            paths.pluginStateDir(subscriber.pluginName),
          );
          const context = makeLandoPluginContext({
            id: subscriber.pluginName,
            managedFileService: managedFiles,
            stateStore,
            pluginStateRoot,
            publishRender: makePublishRender(events, redaction),
          });
          const getHandler = yield* makeCachedSubscriberHandler(
            loadFactory(subscriber),
            context,
            projectedConfig(subscriber, notify),
          );
          handlers.set(subscriber, getHandler);
        }
      }
      yield* dispatchControl.install({
        hasSubscribers: (eventName) => index.has(eventName),
        dispatch: (event) => {
          const entries = index.get(event._tag) ?? [];
          if (!Schema.is(LandoEventSchema)(event)) {
            return Effect.fail(
              new EventError({ event: event._tag, message: "Indexed event failed schema validation." }),
            );
          }
          return Effect.forEach(
            entries,
            (subscriber) => {
              const getHandler = handlers.get(subscriber);
              return getHandler === undefined
                ? Effect.fail(
                    subscriberEventError({ event, subscriber }, "Subscriber cache invariant failed."),
                  )
                : dispatchEntry({ event, subscriber, getHandler, logger });
            },
            { discard: true },
          );
        },
      });
    }),
  );
