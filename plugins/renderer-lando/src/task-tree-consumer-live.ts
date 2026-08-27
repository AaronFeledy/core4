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
import { type SessionSubstrate, commitOpenSession, routeSessionEvent } from "./task-tree-session-consume.ts";
import { type TaskTreeSession, idleSession, shouldFlushSessionOnDispose } from "./task-tree-session.ts";
import { type LiveRegionHandle, makeTaskTreeSubstrateHandler } from "./task-tree-substrate-handler.ts";
import { makeTranscriptTailController } from "./transcript-tail-controller.ts";
import { TranscriptTailReader } from "./transcript-tail-reader.ts";

const taskIdOf = (event: LandoEvent): string | undefined => {
  const value = Reflect.get(event, "taskId");
  return typeof value === "string" ? value : undefined;
};

export const makeTaskTreeConsumerLive = (
  io: RendererIO,
  stdout: NodeJS.WriteStream,
  createLiveRegion: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>,
  raiseInterrupt: () => void,
  prefetchLiveRegion: () => void,
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
      let session: TaskTreeSession = idleSession();
      let active:
        | (SessionSubstrate & { readonly dispose: () => void; readonly hasTasks: () => boolean })
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
          openSession,
          closeSession,
          hasTasks,
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
        const transition = (event: LandoEvent, preferredInternalId?: string): Effect.Effect<boolean> =>
          Effect.gen(function* () {
            const taskId = taskIdOf(event);
            if (taskId === undefined) return false;
            if (event._tag === "task.detail.expand") {
              const previousTaskId = viewModel.expandedTaskId;
              const targetId = preferredInternalId ?? taskId;
              if (previousTaskId !== targetId) viewModel.expandTask(targetId);
              const occurrenceId = viewModel.expandedTaskId;
              if (occurrenceId === undefined) return false;
              const opened = yield* transcriptTail.open(occurrenceId);
              if (!opened) {
                viewModel.collapse();
                return false;
              }
              const entered = yield* Effect.tryPromise({
                try: () => Promise.resolve(controller.enterFullTail()),
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
            const exited = yield* Effect.tryPromise({
              try: () => controller.exitFullTail(),
              catch: (cause) => recordOpenTuiSubstrateFailure(cause),
            }).pipe(Effect.option);
            if (Option.isNone(exited)) {
              viewModel.expandTask(preferredInternalId ?? viewModel.expandedTaskId ?? taskId);
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
            yield* Effect.tryPromise({
              try: () => consumeRenderable(event),
              catch: (cause) => recordOpenTuiSubstrateFailure(cause),
            }).pipe(Effect.ignore);
          });
        handleResize = (width, height) => {
          resize(width, height);
          runInScope(transcriptTail.refresh);
        };
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
                  if (!(yield* transition(event, result.preferredInternalId))) continue;
                  publishedByInput.add(event);
                  yield* events.publish(event);
                }
              }),
            );
          });
        }
        active = {
          controller,
          consume,
          dispose,
          viewModel,
          openSession,
          closeSession,
          hasTasks,
          transcriptTail,
        };
        journal.attach(controller);
        return active;
      });

      const consume = (event: LandoEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (/^cli-.+-init$/.test(event._tag) && Reflect.get(event, "parentInvocationId") === undefined)
            prefetchLiveRegion();
          const routed = yield* routeSessionEvent(
            event,
            session,
            active,
            acquire,
            line,
            recordOpenTuiSubstrateFailure,
          );
          session = routed.session;
        });
      const fiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) yield* serialized(consume(yield* Queue.take(queue)));
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          handleResize = () => {};
          unsubscribe?.();
          const remaining = yield* Queue.takeAll(queue);
          for (const event of remaining) yield* serialized(consume(event));
          yield* Fiber.interrupt(fiber);
          const substrate = active;
          if (substrate !== undefined) {
            if (shouldFlushSessionOnDispose(session, substrate.hasTasks())) {
              session = yield* serialized(
                commitOpenSession(session, substrate, recordOpenTuiSubstrateFailure),
              );
            }
            journal.detach(substrate.controller);
            yield* serialized(substrate.transcriptTail.close);
            substrate.dispose();
            yield* Effect.promise(() =>
              substrate.controller.dispose().catch((cause) => recordOpenTuiSubstrateFailure(cause)),
            );
          }
        }),
      );
    }),
  );
