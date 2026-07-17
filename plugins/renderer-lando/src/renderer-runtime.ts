import { Effect, Fiber, Layer, Option, Queue, Runtime } from "effect";

import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import { EventService, type LandoEvent } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderPlainLine } from "./format.ts";
import { TaskTreeInputController } from "./keybindings.ts";
import {
  type LiveRegionControllerOptions,
  createLiveRegionController,
} from "./opentui/live-region-controller.ts";
import {
  claimOpenTuiDegradationNotice,
  getOpenTuiSubstrateAvailability,
  recordOpenTuiSubstrateFailure,
} from "./opentui/substrate-availability.ts";
import { makeLandoService, makeLineModeConsumer } from "./renderer-service.ts";
import { TaskTreeAnimationController } from "./task-tree-animation.ts";
import { TaskTreeViewModel } from "./task-tree-tail.ts";
import { makeTranscriptTailController } from "./transcript-tail-controller.ts";
import {
  TranscriptTailReader,
  TranscriptTailReaderLive,
  type TranscriptTailReaderShape,
} from "./transcript-tail-reader.ts";

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
  readonly raiseInterrupt?: () => void;
  readonly transcriptReader?: TranscriptTailReaderShape;
}

const DEFAULT_FOOTER_HEIGHT = 12 as const;
const taskIdOf = (event: LandoEvent): string | undefined => {
  const value = Reflect.get(event, "taskId");
  return typeof value === "string" ? value : undefined;
};

/**
 * Drive one event through the substrate: task-tree events reflow the pinned
 * footer (committing the completed tree to scrollback and retiring the footer on
 * completion); expand/collapse toggle the alt-screen full-tail; everything else
 * is passthrough committed to scrollback above the footer.
 */
const makeSubstrateHandler = (io: RendererIO, controller: LiveRegionHandle) => {
  let terminalColumns = io.terminalColumns;
  let terminalRows = io.terminalRows;
  const viewModel = new TaskTreeViewModel({
    getTerminalColumns: () => terminalColumns,
    getTerminalRows: () => terminalRows,
  });
  const renderFooter = (): void => controller.setFooter(viewModel.frameLines());
  const animation = new TaskTreeAnimationController(viewModel, {
    render: renderFooter,
    requestLive: () => controller.requestLive(),
    dropLive: () => controller.dropLive(),
  });
  const handleRenderable = (event: LandoEvent): void => {
    if (isRenderableTaskTreeEvent(event)) {
      const expandedTaskId = viewModel.expandedTaskId;
      viewModel.apply(event);
      animation.consume(event);
      if (expandedTaskId !== undefined && viewModel.expandedTaskId === undefined) {
        controller.exitFullTail();
      }
      if (event._tag === "task.tree.complete") {
        for (const line of viewModel.treeFrameLines()) controller.commitScrollback(line);
        if (viewModel.expandedTaskId !== undefined) {
          renderFooter();
          return;
        }
        controller.setFooter([]);
        return;
      }
      renderFooter();
      return;
    }
    const line = renderPlainLine(event);
    if (line !== null) controller.commitScrollback(line);
  };
  const resize = (width: number, height: number): void => {
    terminalColumns = width;
    terminalRows = height;
    renderFooter();
  };
  return { viewModel, handleRenderable, resize, renderFooter, dispose: () => animation.dispose() };
};

const makeSubstrateConsumerLive = (
  io: RendererIO,
  stdout: NodeJS.WriteStream,
  createLiveRegion: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>,
  raiseInterrupt: () => void,
): Layer.Layer<never, never, EventService | TranscriptTailReader> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const events = yield* EventService;
      const transcriptReader = yield* TranscriptTailReader;
      const semaphore = yield* Effect.makeSemaphore(1);
      const serialized = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        semaphore.withPermits(1)(effect);
      let handleResize = (_width: number, _height: number): void => {};
      const availability = getOpenTuiSubstrateAvailability();
      const acquired = availability.available
        ? yield* Effect.tryPromise(() =>
            createLiveRegion({
              stdout,
              width: io.terminalColumns ?? 80,
              height: io.terminalRows ?? 24,
              footerHeight: DEFAULT_FOOTER_HEIGHT,
              onResize: (width, height) => handleResize(width, height),
            }),
          ).pipe(
            Effect.tapError((cause) => Effect.sync(() => recordOpenTuiSubstrateFailure(cause))),
            Effect.option,
          )
        : Option.none<LiveRegionHandle>();
      const degradationCause = Option.isNone(acquired) ? claimOpenTuiDegradationNotice() : undefined;
      if (degradationCause !== undefined) {
        yield* Effect.logDebug("OpenTUI live region unavailable; degrading to line rendering.").pipe(
          Effect.annotateLogs({ cause: String(degradationCause) }),
        );
      }
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
      const { viewModel, handleRenderable, resize, renderFooter, dispose } = makeSubstrateHandler(
        io,
        controller,
      );
      const transcriptTail = yield* makeTranscriptTailController({
        reader: transcriptReader,
        viewModel,
        renderFooter,
        serialize: serialized,
      });
      const runtime = yield* Effect.runtime<never>();
      const handle = (event: LandoEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (event._tag === "task.detail.expand") {
            const taskId = taskIdOf(event);
            if (taskId === undefined) return;
            const opened = yield* transcriptTail.open(taskId);
            if (!opened) {
              viewModel.collapse();
              return;
            }
            controller.enterFullTail();
            renderFooter();
            return;
          }
          if (event._tag === "task.detail.collapse") {
            yield* transcriptTail.close;
            controller.exitFullTail();
            renderFooter();
            return;
          }
          handleRenderable(event);
        });
      handleResize = (width, height) => {
        resize(width, height);
        Runtime.runFork(runtime)(serialized(transcriptTail.refresh));
      };
      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) yield* serialized(handle(yield* Queue.take(queue)));
        }),
      );
      const subscribe = io.subscribeInput;
      let unsubscribe: (() => void) | undefined;
      if (subscribe !== undefined) {
        const input = new TaskTreeInputController(viewModel);
        unsubscribe = subscribe((raw) => {
          if (raw.includes("\x03")) {
            raiseInterrupt();
            return;
          }
          Runtime.runFork(runtime)(
            serialized(
              Effect.gen(function* () {
                const result = input.handleInput(raw);
                if (!result.changed) return;
                if (result.transcriptPage !== undefined) {
                  yield* transcriptTail.page(result.transcriptPage);
                  return;
                }
                if (result.events.length === 0) renderFooter();
                for (const event of result.events) yield* events.publish(event);
              }),
            ),
          );
        });
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          unsubscribe?.();
          const remaining = yield* Queue.takeAll(queue).pipe(Effect.option);
          if (Option.isSome(remaining)) for (const event of remaining.value) yield* serialized(handle(event));
          yield* Fiber.interrupt(fiber);
          yield* serialized(transcriptTail.close);
          dispose();
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
  const raiseInterrupt = deps.raiseInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  const readerLayer =
    deps.transcriptReader === undefined
      ? TranscriptTailReaderLive
      : Layer.succeed(TranscriptTailReader, deps.transcriptReader);
  return makeSubstrateConsumerLive(io, stdout, createLiveRegion, raiseInterrupt).pipe(
    Layer.provide(readerLayer),
  );
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
