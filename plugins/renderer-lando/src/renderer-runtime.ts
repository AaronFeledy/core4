import { Effect, Fiber, Layer, Option, Queue } from "effect";

import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_TTY_INITIAL } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, type Renderer } from "@lando/sdk/services";

import {
  type CapabilityProbe,
  type CapabilitySnapshotHandle,
  createCapabilitySnapshot,
  scheduleCapabilityProbe,
} from "./capabilities.ts";
import { sanitizeNotificationText } from "./notify-sanitize.ts";
import {
  flushPendingNotifications,
  productionCapabilityProbe,
  productionTriggerNotificationSync,
} from "./notify-trigger.ts";
import type { LiveRegionControllerOptions } from "./opentui/live-region-controller.ts";
import { createLiveRegionController } from "./opentui/live-region-controller.ts";
import { makeLineModeConsumer, makeLandoService as makeRendererService } from "./renderer-service.ts";
import { makeTaskTreeConsumerLive } from "./task-tree-consumer-live.ts";
import type { LiveRegionHandle } from "./task-tree-substrate-handler.ts";
import {
  TranscriptTailReader,
  TranscriptTailReaderLive,
  type TranscriptTailReaderShape,
} from "./transcript-tail-reader.ts";

export type LandoRendererServiceOptions = {
  readonly capabilityProbe?: CapabilityProbe;
  readonly triggerNotification?: (message: string, title?: string) => boolean;
  readonly clock?: { readonly setTimeout: (fn: () => void, ms: number) => unknown };
  readonly flushNotifications?: () => Promise<void>;
};

export interface LandoEventConsumerDeps extends LandoRendererServiceOptions {
  readonly createLiveRegion?: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>;
  readonly raiseInterrupt?: () => void;
  readonly transcriptReader?: TranscriptTailReaderShape;
  readonly getCapabilities?: () => { readonly notifications: boolean };
}

const capabilitySnapshotsByIo = new WeakMap<object, CapabilitySnapshotHandle>();

export const resolveCapabilitySnapshot = (
  io: RendererIO,
  options: LandoRendererServiceOptions = {},
): CapabilitySnapshotHandle => {
  const key = io as object;
  const existing = capabilitySnapshotsByIo.get(key);
  if (existing !== undefined) return existing;
  const tty = io.isTTY === true;
  const snapshot = createCapabilitySnapshot(
    tty ? RENDERER_CAPABILITIES_TTY_INITIAL : RENDERER_CAPABILITIES_NONE,
  );
  if (tty) scheduleCapabilityProbe(snapshot, options.capabilityProbe, options.clock);
  capabilitySnapshotsByIo.set(key, snapshot);
  return snapshot;
};

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

const makeNotificationConsumerLive = (
  getCapabilities: () => { readonly notifications: boolean },
  triggerNotification: ((message: string, title?: string) => boolean) | undefined,
  flushNotifications: (() => Promise<void>) | undefined,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
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
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) consume(event);
          }
          if (flushNotifications !== undefined) yield* Effect.promise(flushNotifications);
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

export const makeLandoService = (
  io: RendererIO,
  options: LandoRendererServiceOptions = {},
): Layer.Layer<Renderer> => {
  const snapshot = resolveCapabilitySnapshot(io, options);
  return makeRendererService(io, () => snapshot.get());
};

export const makeLandoEventConsumer = (
  io: RendererIO,
  deps: LandoEventConsumerDeps = {},
): Layer.Layer<never, never, EventService> => {
  const snapshot = deps.getCapabilities === undefined ? resolveCapabilitySnapshot(io, deps) : undefined;
  const getCapabilities =
    deps.getCapabilities ??
    (() =>
      snapshot?.get() ??
      (io.isTTY === true ? RENDERER_CAPABILITIES_TTY_INITIAL : RENDERER_CAPABILITIES_NONE));
  const notifications = makeNotificationConsumerLive(
    getCapabilities,
    deps.triggerNotification,
    deps.flushNotifications,
  );
  if (io.isTTY !== true) return Layer.merge(makeLineModeConsumer(io), notifications);
  const stdout = io.externalOutputStream;
  if (stdout === undefined) return Layer.merge(makeLineModeConsumer(io), notifications);
  const createLiveRegion = deps.createLiveRegion ?? ((options) => createLiveRegionController(options));
  const raiseInterrupt = deps.raiseInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  const readerLayer =
    deps.transcriptReader === undefined
      ? TranscriptTailReaderLive
      : Layer.succeed(TranscriptTailReader, deps.transcriptReader);
  const taskTree = makeTaskTreeConsumerLive(io, stdout, createLiveRegion, raiseInterrupt).pipe(
    Layer.provide(readerLayer),
  );
  return Layer.merge(taskTree, notifications);
};

export const landoRendererContribution: RendererContribution = {
  id: "lando",
  makeService: (io) =>
    makeLandoService(io, io.isTTY === true ? { capabilityProbe: productionCapabilityProbe() } : {}),
  makeEventConsumer: (io) => {
    const snapshot = resolveCapabilitySnapshot(
      io,
      io.isTTY === true ? { capabilityProbe: productionCapabilityProbe() } : {},
    );
    return makeLandoEventConsumer(io, {
      getCapabilities: () => snapshot.get(),
      triggerNotification: productionTriggerNotificationSync,
      flushNotifications: flushPendingNotifications,
    });
  },
};
