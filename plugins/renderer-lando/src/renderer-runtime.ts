import { Effect, Fiber, Layer, Option, Queue } from "effect";

import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_TTY } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, type Renderer } from "@lando/sdk/services";

import { sanitizeNotificationText } from "./notify-sanitize.ts";
import { bindIoDesktopNotificationTrigger, flushPendingNotifications } from "./notify-trigger.ts";
import type { LiveRegionControllerOptions } from "./opentui/live-region-controller.ts";
import { createLiveRegionController } from "./opentui/live-region-controller.ts";
import { prefetchLiveRegionModule } from "./opentui/live-region-substrate.ts";
import type { OpenTuiLiveRegionModuleLike } from "./opentui/live-region-types.ts";
import { makeLineModeConsumer, makeLandoService as makeRendererService } from "./renderer-service.ts";
import * as TaskTreeConsumer from "./task-tree-consumer.ts";
import type { LiveRegionHandle } from "./task-tree-substrate-handler.ts";
import { TranscriptTailReader, type TranscriptTailReaderShape } from "./transcript-tail-reader.ts";

export type LandoRendererServiceOptions = {
  readonly triggerNotification?: (message: string, title?: string) => boolean;
  readonly flushNotifications?: () => Promise<void>;
};

export interface LandoEventConsumerDeps extends LandoRendererServiceOptions {
  readonly createLiveRegion?: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>;
  readonly loadModule?: () => Promise<OpenTuiLiveRegionModuleLike>;
  readonly raiseInterrupt?: () => void;
  readonly transcriptReader?: TranscriptTailReaderShape;
}

const handleNotifyDesktop = (
  event: LandoEvent,
  getCapabilities: () => { readonly notifications: boolean },
  triggerNotification: ((message: string, title?: string) => boolean) | undefined,
): void => {
  if (event._tag !== "notify.desktop" || !getCapabilities().notifications) return;
  if (triggerNotification === undefined) return;
  const title = sanitizeNotificationText(String(event.title ?? ""));
  if (title.length === 0) return;
  if (typeof event.body !== "string") {
    triggerNotification(title);
    return;
  }
  const body = sanitizeNotificationText(event.body);
  triggerNotification(body.length === 0 ? title : body, body.length === 0 ? undefined : title);
};

const layerNotificationConsumer = (
  getCapabilities: () => { readonly notifications: boolean },
  triggerNotification: ((message: string, title?: string) => boolean) | undefined,
  flushNotifications: (() => Promise<void>) | undefined,
): Layer.Layer<never, never, EventService> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const queue = yield* events.subscribeQueue;
      const consume = (event: LandoEvent): void =>
        handleNotifyDesktop(event, getCapabilities, triggerNotification);
      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) consume(yield* Queue.take(queue));
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Fiber.interrupt(fiber);
          const remaining = yield* Queue.clear(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) consume(event);
          }
          if (flushNotifications !== undefined) yield* Effect.promise(flushNotifications);
        }),
      );
    }),
  );

export const makeLandoService = (io: RendererIO): Layer.Layer<Renderer> => {
  const capabilities = io.isTTY === true ? RENDERER_CAPABILITIES_TTY : RENDERER_CAPABILITIES_NONE;
  return makeRendererService(io, () => capabilities);
};

export const makeLandoEventConsumer = (
  io: RendererIO,
  deps: LandoEventConsumerDeps = {},
): Layer.Layer<never, never, EventService> => {
  const capabilities = io.isTTY === true ? RENDERER_CAPABILITIES_TTY : RENDERER_CAPABILITIES_NONE;
  const notifications = layerNotificationConsumer(
    () => capabilities,
    deps.triggerNotification,
    deps.flushNotifications,
  );
  if (io.isTTY !== true) return Layer.merge(makeLineModeConsumer(io), notifications);
  const stdout = io.externalOutputStream;
  if (stdout === undefined) return Layer.merge(makeLineModeConsumer(io), notifications);
  const loadModule = deps.loadModule;
  const createLiveRegion =
    deps.createLiveRegion ??
    ((options) => createLiveRegionController(options, loadModule === undefined ? {} : { loadModule }));
  let prefetchLiveRegion: () => void;
  if (loadModule !== undefined) {
    prefetchLiveRegion = () => prefetchLiveRegionModule(loadModule);
  } else if (deps.createLiveRegion === undefined) {
    prefetchLiveRegion = prefetchLiveRegionModule;
  } else {
    prefetchLiveRegion = () => {};
  }
  const raiseInterrupt = deps.raiseInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  const readerLayer =
    deps.transcriptReader === undefined
      ? TranscriptTailReader.layer
      : Layer.succeed(TranscriptTailReader, TranscriptTailReader.of(deps.transcriptReader));
  const taskTree = TaskTreeConsumer.layer(
    io,
    stdout,
    createLiveRegion,
    raiseInterrupt,
    prefetchLiveRegion,
  ).pipe(Layer.provide(readerLayer));
  return Layer.merge(taskTree, notifications);
};

export const landoRendererContribution: RendererContribution = {
  id: "lando",
  makeService: makeLandoService,
  makeEventConsumer: (io) =>
    makeLandoEventConsumer(io, {
      triggerNotification: bindIoDesktopNotificationTrigger(io),
      flushNotifications: flushPendingNotifications,
    }),
};
