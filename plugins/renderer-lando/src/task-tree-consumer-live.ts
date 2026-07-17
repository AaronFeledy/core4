import { Effect, Fiber, Layer, Option, Queue, Runtime } from "effect";

import type { RendererIO } from "@lando/sdk/renderer";
import { EventService, type LandoEvent } from "@lando/sdk/services";

import { renderPlainLine } from "./format.ts";
import { TaskTreeInputController } from "./keybindings.ts";
import type { LiveRegionControllerOptions } from "./opentui/live-region-controller.ts";
import {
  claimOpenTuiDegradationNotice,
  getOpenTuiSubstrateAvailability,
  recordOpenTuiSubstrateFailure,
} from "./opentui/substrate-availability.ts";
import { outputJournalFor } from "./renderer-output-journal.ts";
import { type LiveRegionHandle, makeTaskTreeSubstrateHandler } from "./task-tree-substrate-handler.ts";
import { makeTranscriptTailController } from "./transcript-tail-controller.ts";
import { TranscriptTailReader } from "./transcript-tail-reader.ts";

const DEFAULT_FOOTER_HEIGHT = 12 as const;

const taskIdOf = (event: LandoEvent): string | undefined => {
  const value = Reflect.get(event, "taskId");
  return typeof value === "string" ? value : undefined;
};

export const makeTaskTreeConsumerLive = (
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
      const journal = outputJournalFor(io);
      const queue = yield* events.subscribeQueue;
      const runtime = yield* Effect.runtime<never>();
      const scope = yield* Effect.scope;
      let handleResize = (_width: number, _height: number): void => {};
      let unsubscribe: (() => void) | undefined;
      let active:
        | {
            readonly controller: LiveRegionHandle;
            readonly consume: (event: LandoEvent) => Effect.Effect<void>;
            readonly dispose: () => void;
            readonly transcriptTail: Effect.Effect.Success<ReturnType<typeof makeTranscriptTailController>>;
          }
        | undefined;

      const line = (event: LandoEvent): void => {
        const text = renderPlainLine(event);
        if (text !== null) journal.writeStdout(`${text}\n`);
      };
      const reportDegradation = Effect.suspend(() => {
        const cause = claimOpenTuiDegradationNotice();
        return cause === undefined
          ? Effect.void
          : Effect.logDebug("OpenTUI live region unavailable; degrading to line rendering.").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            );
      });
      const runInScope = <A, E>(effect: Effect.Effect<A, E>): void => {
        Runtime.runFork(runtime)(
          Effect.forkIn(serialized(effect).pipe(Effect.ignore), scope).pipe(Effect.asVoid),
        );
      };

      const acquire = Effect.gen(function* () {
        if (active !== undefined) return active;
        if (!getOpenTuiSubstrateAvailability().available) {
          yield* reportDegradation;
          return undefined;
        }
        const acquired = yield* Effect.tryPromise(() =>
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
        );
        if (Option.isNone(acquired)) {
          yield* reportDegradation;
          return undefined;
        }
        const controller = acquired.value;
        const {
          viewModel,
          consume: consumeRenderable,
          resize,
          renderFooter,
          dispose,
        } = makeTaskTreeSubstrateHandler(io, controller);
        const transcriptTail = yield* makeTranscriptTailController({
          reader: transcriptReader,
          viewModel,
          renderFooter,
          serialize: serialized,
        });
        const input = new TaskTreeInputController(viewModel);
        const publishedByInput = new WeakSet<LandoEvent>();
        const transition = (event: LandoEvent): Effect.Effect<boolean> =>
          Effect.gen(function* () {
            const taskId = taskIdOf(event);
            if (taskId === undefined) return false;
            if (event._tag === "task.detail.expand") {
              const previousTaskId = viewModel.expandedTaskId;
              if (previousTaskId !== taskId) viewModel.expandTask(taskId);
              if (viewModel.expandedTaskId !== taskId) return false;
              const opened = yield* transcriptTail.open(taskId);
              if (!opened) {
                viewModel.collapse();
                return false;
              }
              const entered = yield* Effect.try({
                try: () => controller.enterFullTail(),
                catch: (cause) => recordOpenTuiSubstrateFailure(cause),
              }).pipe(Effect.option);
              if (Option.isNone(entered)) {
                yield* transcriptTail.close;
                if (previousTaskId === undefined) viewModel.collapse();
                else viewModel.expandTask(previousTaskId);
                renderFooter();
                return false;
              }
              renderFooter();
              return true;
            }
            if (event._tag !== "task.detail.collapse") return false;
            const exited = yield* Effect.try({
              try: () => controller.exitFullTail(),
              catch: (cause) => recordOpenTuiSubstrateFailure(cause),
            }).pipe(Effect.option);
            if (Option.isNone(exited)) {
              viewModel.expandTask(taskId);
              yield* transcriptTail.refresh;
              return false;
            }
            yield* transcriptTail.close;
            viewModel.collapse();
            renderFooter();
            return true;
          });
        const consume = (event: LandoEvent): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (publishedByInput.delete(event)) return;
            if (event._tag === "task.detail.expand" || event._tag === "task.detail.collapse") {
              yield* transition(event);
              return;
            }
            consumeRenderable(event);
          });
        handleResize = (width, height) =>
          runInScope(Effect.sync(() => resize(width, height)).pipe(Effect.zipRight(transcriptTail.refresh)));
        const subscribe = io.subscribeInput;
        if (subscribe !== undefined) {
          unsubscribe = subscribe((raw) => {
            if (raw.includes("\x03")) {
              raiseInterrupt();
              return;
            }
            runInScope(
              Effect.gen(function* () {
                const result = input.handleInput(raw);
                if (!result.changed) return;
                if (result.transcriptPage !== undefined) {
                  yield* transcriptTail.page(result.transcriptPage);
                  return;
                }
                if (result.events.length === 0) {
                  renderFooter();
                  return;
                }
                for (const event of result.events) {
                  if (!(yield* transition(event))) continue;
                  publishedByInput.add(event);
                  yield* events.publish(event);
                }
              }),
            );
          });
        }
        active = { controller, consume, dispose, transcriptTail };
        journal.attach(controller);
        return active;
      });

      const consume = (event: LandoEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (active !== undefined) {
            yield* active.consume(event);
            return;
          }
          if (event._tag !== "task.tree.start") {
            line(event);
            return;
          }
          const substrate = yield* acquire;
          if (substrate === undefined) line(event);
          else yield* substrate.consume(event);
        });
      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) yield* serialized(consume(yield* Queue.take(queue)));
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          unsubscribe?.();
          const remaining = yield* Queue.takeAll(queue);
          for (const event of remaining) yield* serialized(consume(event));
          yield* Fiber.interrupt(fiber);
          if (active !== undefined) {
            journal.detach(active.controller);
            yield* serialized(active.transcriptTail.close);
            active.dispose();
            active.controller.dispose();
          }
        }),
      );
    }),
  );
