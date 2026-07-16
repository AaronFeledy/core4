import { DateTime, Effect, Fiber, Layer, Option, Queue, Runtime } from "effect";

import { MessageErrorEvent, MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import { EventService, type LandoEvent, Renderer } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderPlainLine } from "./format.ts";
import { TaskTreeInputController } from "./keybindings.ts";
import {
  type LiveRegionControllerOptions,
  createLiveRegionController,
} from "./opentui/live-region-controller.ts";
import { TaskTreeViewModel } from "./task-tree-tail.ts";

/** Injectable subset of the split-footer live region the consumer drives (real controller or test fake). */
interface LiveRegionHandle {
  setFooter(lines: ReadonlyArray<string>): void;
  commitScrollback(text: string): void;
  requestLive(): void;
  dropLive(): void;
  enterFullTail(): void;
  exitFullTail(): void;
  dispose(): void;
}

export interface LandoEventConsumerDeps {
  readonly createLiveRegion?: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>;
}

const DEFAULT_FOOTER_HEIGHT = 12 as const;

/**
 * Wrap a synchronous per-event handler in the `EventService`
 * subscription/drain layer: events are consumed in order and any queued
 * remainder is flushed on scope close before the consumer fiber is interrupted.
 */
const makeEventConsumerLive = (
  handle: (event: LandoEvent) => void,
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
          yield* Fiber.interrupt(fiber);
        }),
      );
    }),
  );

const nowTimestamp = (): DateTime.Utc => DateTime.unsafeMake(new Date().toISOString());

/**
 * Build the `message.{info,warn,error}` contract: each severity is encoded as
 * the canonical `message.*` event, formatted by the plain line formatter, and
 * written to stdout so imperative and published messages render identically.
 */
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

/**
 * Raw `output.{stdout,stderr}` channel: chunks are written verbatim (no glyph
 * or newline injection), carrying already-formatted command results (stdout)
 * and process-level failure diagnostics (stderr).
 */
const makeOutputChannel = (io: RendererIO) => ({
  stdout: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStdout(chunk)),
  stderr: (chunk: string): Effect.Effect<void> => Effect.sync(() => io.writeStderr(chunk)),
});

const makeLandoService = (io: RendererIO): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, {
    id: "lando",
    message: makeMessageContract(io),
    output: makeOutputChannel(io),
  });

const makeLineModeConsumer = (io: RendererIO): Layer.Layer<never, never, EventService> =>
  makeEventConsumerLive((event) => {
    const line = renderPlainLine(event);
    if (line !== null) io.writeStdout(`${line}\n`);
  });

/**
 * Drive one event through the substrate: task-tree events reflow the pinned
 * footer (committing the completed tree to scrollback and retiring the footer on
 * completion); expand/collapse toggle the alt-screen full-tail; everything else
 * is passthrough committed to scrollback above the footer.
 */
const makeSubstrateHandler = (io: RendererIO, controller: LiveRegionHandle) => {
  const viewModel = new TaskTreeViewModel({
    getTerminalColumns: () => io.terminalColumns,
    getTerminalRows: () => io.terminalRows,
  });
  let liveActive = false;
  const syncLive = (): void => {
    const animated = viewModel.hasAnimatedAffordance();
    if (animated && !liveActive) {
      controller.requestLive();
      liveActive = true;
    } else if (!animated && liveActive) {
      controller.dropLive();
      liveActive = false;
    }
  };
  const handle = (event: LandoEvent): void => {
    if (event._tag === "task.detail.expand") {
      controller.enterFullTail();
      controller.setFooter(viewModel.frameLines());
      return;
    }
    if (event._tag === "task.detail.collapse") {
      controller.exitFullTail();
      controller.setFooter(viewModel.frameLines());
      return;
    }
    if (isRenderableTaskTreeEvent(event)) {
      viewModel.apply(event);
      if (event._tag === "task.tree.complete") {
        for (const line of viewModel.frameLines()) controller.commitScrollback(line);
        controller.setFooter([]);
        syncLive();
        return;
      }
      controller.setFooter(viewModel.frameLines());
      syncLive();
      return;
    }
    const line = renderPlainLine(event);
    if (line !== null) controller.commitScrollback(line);
  };
  return { viewModel, handle };
};

const makeSubstrateConsumerLive = (
  io: RendererIO,
  stdout: NodeJS.WriteStream,
  createLiveRegion: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>,
): Layer.Layer<never, never, EventService> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const acquired = yield* Effect.tryPromise(() =>
        createLiveRegion({
          stdout,
          width: io.terminalColumns ?? 80,
          height: io.terminalRows ?? 24,
          footerHeight: DEFAULT_FOOTER_HEIGHT,
        }),
      ).pipe(Effect.option);
      const queue = yield* events.subscribeQueue;
      if (Option.isNone(acquired)) {
        const line = (event: LandoEvent): void => {
          const text = renderPlainLine(event);
          if (text !== null) io.writeStdout(`${text}\n`);
        };
        const fiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) line(yield* Queue.take(queue));
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
            if (Option.isSome(remaining)) for (const event of remaining.value) line(event);
            yield* Fiber.interrupt(fiber);
          }),
        );
        return;
      }
      const controller = acquired.value;
      const { viewModel, handle } = makeSubstrateHandler(io, controller);
      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) handle(yield* Queue.take(queue));
        }),
      );
      const subscribe = io.subscribeInput;
      let unsubscribe: (() => void) | undefined;
      if (subscribe !== undefined) {
        const runtime = yield* Effect.runtime<never>();
        const input = new TaskTreeInputController(viewModel);
        unsubscribe = subscribe((raw) => {
          const result = input.handleInput(raw);
          if (!result.changed) return;
          for (const event of result.events) Runtime.runFork(runtime)(events.publish(event));
        });
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          unsubscribe?.();
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) for (const event of remaining.value) handle(event);
          yield* Fiber.interrupt(fiber);
          controller.dispose();
        }),
      );
    }),
  );

const makeLandoEventConsumer = (
  io: RendererIO,
  deps: LandoEventConsumerDeps = {},
): Layer.Layer<never, never, EventService> => {
  if (io.isTTY !== true) return makeLineModeConsumer(io);
  const stdout = io.externalOutputStream;
  if (stdout === undefined) return makeLineModeConsumer(io);
  const createLiveRegion = deps.createLiveRegion ?? ((options) => createLiveRegionController(options));
  return makeSubstrateConsumerLive(io, stdout, createLiveRegion);
};

export { makeLandoEventConsumer };

/**
 * The default `lando` renderer contribution: the task-tree painter and event
 * consumer, the `Renderer` service (plain message contract + raw output
 * channel), and the non-TTY plain fallback. This is the maintained first-party
 * reference implementation renderer-plugin authors follow.
 */
export const landoRendererContribution: RendererContribution = {
  id: "lando",
  makeService: (io) => makeLandoService(io),
  makeEventConsumer: (io) => makeLandoEventConsumer(io),
};
