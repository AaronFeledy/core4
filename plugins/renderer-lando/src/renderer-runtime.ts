import { DateTime, Effect, Fiber, Layer, Option, Queue, Runtime } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_TTY_INITIAL } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import {
  type CapabilityProbe,
  type CapabilitySnapshotHandle,
  createCapabilitySnapshot,
  scheduleCapabilityProbe,
} from "./capabilities.ts";
import { isRenderableTaskTreeEvent, renderPlainLine } from "./format.ts";
import { TaskTreeInputController } from "./keybindings.ts";
import { sanitizeNotificationText } from "./notify-sanitize.ts";
import {
  flushPendingNotifications,
  productionCapabilityProbe,
  productionTriggerNotificationSync,
} from "./notify-trigger.ts";
import { LandoTreePainter } from "./task-tree-tail.ts";

export type LandoRendererServiceOptions = {
  readonly capabilityProbe?: CapabilityProbe;
  readonly triggerNotification?: (message: string, title?: string) => boolean;
  readonly clock?: { readonly setTimeout: (fn: () => void, ms: number) => unknown };
  /** Optional flush for async production notification delivery (tests may inject). */
  readonly flushNotifications?: () => Promise<void>;
};

/**
 * One capability snapshot per RendererIO instance so makeService and
 * makeEventConsumer share the same initial/promoted objects and never run two
 * independent probes for the same run.
 */
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
  if (tty) {
    scheduleCapabilityProbe(snapshot, options.capabilityProbe, options.clock);
  }
  capabilitySnapshotsByIo.set(key, snapshot);
  return snapshot;
};

const makeEventConsumerLive = (
  handle: (event: LandoEvent) => void,
  flushNotifications?: () => Promise<void>,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const queue = yield* events.subscribeQueue;
      const consumer = Effect.gen(function* () {
        while (true) {
          handle(yield* Queue.take(queue));
        }
      });
      const fiber = yield* Effect.forkScoped(consumer);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) {
            for (const event of remaining.value) handle(event);
          }
          if (flushNotifications !== undefined) {
            yield* Effect.promise(flushNotifications);
          }
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

const nowTimestamp = (): DateTime.Utc => DateTime.unsafeMake(new Date().toISOString());

const makeMessageContract = (io: RendererIO) => {
  const emit = (event: LandoEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const line = renderPlainLine(event);
      if (line !== null) io.writeStdout(`${line}\n`);
    });
  return {
    info: (body: string): Effect.Effect<void> =>
      emit(MessageInfoEvent.make({ body, timestamp: nowTimestamp() })),
    warn: (body: string): Effect.Effect<void> =>
      emit(MessageWarnEvent.make({ body, timestamp: nowTimestamp() })),
    error: (body: string, remediation?: string): Effect.Effect<void> =>
      emit(
        MessageErrorEvent.make(
          remediation === undefined
            ? { body, timestamp: nowTimestamp() }
            : { body, remediation, timestamp: nowTimestamp() },
        ),
      ),
  };
};

const makeOutputChannel = (io: RendererIO) => ({
  stdout: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStdout(chunk)),
  stderr: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStderr(chunk)),
});

const makeTaskTreeInputLive = (
  io: RendererIO,
  painter: LandoTreePainter,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const subscribe = io.subscribeInput;
      if (subscribe === undefined) return;
      const events = yield* EventService;
      const runtime = yield* Effect.runtime<never>();
      const controller = new TaskTreeInputController(painter);
      const unsubscribe = subscribe((raw) => {
        const result = controller.handleInput(raw);
        if (!result.changed) return;
        if (result.redraw.length > 0) io.writeStdout(result.redraw);
        for (const event of result.events) Runtime.runFork(runtime)(events.publish(event));
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }),
  );

const handleNotifyDesktop = (
  event: LandoEvent,
  getCapabilities: () => { readonly notifications: boolean },
  triggerNotification: ((message: string, title?: string) => boolean) | undefined,
): void => {
  if (event._tag !== "notify.desktop") return;
  if (!getCapabilities().notifications) return;
  if (triggerNotification === undefined) return;
  const title = sanitizeNotificationText(String(event.title ?? ""));
  if (title.length === 0) return;
  const bodyRaw = event.body;
  if (typeof bodyRaw === "string") {
    const body = sanitizeNotificationText(bodyRaw);
    // OpenTUI: triggerNotification(body ?? title, body === undefined ? undefined : title)
    triggerNotification(body.length === 0 ? title : body, body.length === 0 ? undefined : title);
    return;
  }
  triggerNotification(title);
};

export const makeLandoService = (
  io: RendererIO,
  options: LandoRendererServiceOptions = {},
): Layer.Layer<Renderer> => {
  const snapshot = resolveCapabilitySnapshot(io, options);
  const service = {
    id: "lando" as const,
    get capabilities() {
      return snapshot.get();
    },
    message: makeMessageContract(io),
    output: makeOutputChannel(io),
  };
  return Layer.succeed(Renderer, service);
};

export const makeLandoEventConsumer = (
  io: RendererIO,
  options: LandoRendererServiceOptions & {
    readonly getCapabilities?: () => { readonly notifications: boolean };
  } = {},
): Layer.Layer<never, never, EventService> => {
  const snapshot = options.getCapabilities === undefined ? resolveCapabilitySnapshot(io, options) : undefined;
  const getCapabilities =
    options.getCapabilities ??
    (() =>
      snapshot?.get() ??
      (io.isTTY === true ? RENDERER_CAPABILITIES_TTY_INITIAL : RENDERER_CAPABILITIES_NONE));
  const trigger = options.triggerNotification;
  const flush = options.flushNotifications;

  if (io.isTTY !== true) {
    return makeEventConsumerLive((event) => {
      handleNotifyDesktop(event, getCapabilities, trigger);
      const line = renderPlainLine(event);
      if (line !== null) io.writeStdout(`${line}\n`);
    }, flush);
  }
  const painter = new LandoTreePainter({
    getTerminalColumns: () => io.terminalColumns,
    getTerminalRows: () => io.terminalRows,
  });
  const display = makeEventConsumerLive((event) => {
    handleNotifyDesktop(event, getCapabilities, trigger);
    if (isRenderableTaskTreeEvent(event)) {
      io.writeStdout(painter.consume(event));
      return;
    }
    const line = renderPlainLine(event);
    if (line !== null) io.writeStdout(painter.passthrough(line));
  }, flush);
  return io.subscribeInput === undefined ? display : Layer.merge(display, makeTaskTreeInputLive(io, painter));
};

export const landoRendererContribution: RendererContribution = {
  id: "lando",
  makeService: (io) =>
    makeLandoService(io, io.isTTY === true ? { capabilityProbe: productionCapabilityProbe() } : {}),
  makeEventConsumer: (io) => {
    // Reuse the same snapshot/probe as makeService when both run against the same
    // RendererIO (the production CLI path). Production triggerNotification is
    // async under the hood; flushPendingNotifications runs in the consumer finalizer.
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
