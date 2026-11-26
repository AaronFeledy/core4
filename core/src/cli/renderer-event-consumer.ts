/**
 * The event consumer one command run renders its events through.
 *
 * Human routes narrate events through the selected renderer, envelope routes
 * consume only notifications, and the frame route writes each event as a
 * machine frame. A consumer runs for the command and retires before the run
 * concludes, so nothing it writes can follow the terminal document.
 */

import type { RedactionService } from "@lando/redaction/service";
import type { RendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import type { RendererContribution } from "@lando/sdk/renderer";
import type { Redactor } from "@lando/sdk/secrets";
import type { EventService, LandoEvent } from "@lando/sdk/services";
import { Effect, Exit, Layer, Scope } from "effect";
import { FinishCommandProgress } from "./command-progress";
import type { CommandWarningsShape } from "./command-warnings";
import { interruptOnAbort } from "./interrupt-on-abort";
import type { OutputRouting } from "./output-routing";
import { startMachineEventConsumer } from "./renderer-machine-events";
import type { RendererMode } from "./renderer-selection";

/** Selects the event consumer layer for the given routing and renderer mode. */
export const selectEventConsumerLayer = (
  routing: OutputRouting,
  rendererMode: RendererMode,
  io: RendererIO,
  landoRenderer: RendererContribution,
): Layer.Layer<never, never, EventService> | undefined => {
  switch (routing.events) {
    case "mode-narration":
    case "json-event-dump":
    case "verbose-dump":
      return RendererOutput.layerEventConsumerForMode(rendererMode, io, { landoRenderer });
    case "notifications-only":
    case "silent-lando-consumer":
      return RendererOutput.layerNotificationConsumerForMode(rendererMode, landoRenderer, io);
    case "frames":
    case "none":
      return undefined;
    default: {
      const exhaustive: never = routing;
      return exhaustive;
    }
  }
};

export interface EventConsumerOptions {
  readonly routing: OutputRouting;
  readonly rendererMode: RendererMode;
  readonly io: RendererIO;
  readonly landoRenderer: RendererContribution;
  readonly signal: AbortSignal | undefined;
  readonly commandWarnings: CommandWarningsShape;
  /** The frame route's redactor and event-frame encoder. */
  readonly frameRedactor: Effect.Effect<Redactor, never, RedactionService>;
  readonly encodeEventFrame: (event: LandoEvent, redactor: Redactor) => Effect.Effect<string>;
}

/**
 * Runs `execute` with the route's event consumer. `execute` receives the
 * frame consumer's retirement, which it runs once the command has finished;
 * a narration consumer retires through `FinishCommandProgress` instead.
 */
export const withEventConsumer = <A, E, R>(
  execute: (finishFrames: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  options: EventConsumerOptions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (options.routing.events === "frames") {
        const redactor = yield* options.frameRedactor;
        const finish = yield* interruptOnAbort(
          startMachineEventConsumer(options.encodeEventFrame, redactor),
          options.signal,
        );
        const finishFrames = interruptOnAbort(
          Effect.gen(function* () {
            const dropped = yield* finish;
            if (dropped > 0)
              yield* options.commandWarnings.add({
                code: "LANDO_EVENT_FRAMES_DROPPED",
                message: `${dropped} events were dropped because the output reader fell behind.`,
              });
          }),
          options.signal,
        );
        return yield* execute(finishFrames);
      }
      const layer = selectEventConsumerLayer(
        options.routing,
        options.rendererMode,
        options.io,
        options.landoRenderer,
      );
      if (layer === undefined) return yield* execute(Effect.void);
      const consumerScope = yield* Scope.fork(yield* Effect.scope, "sequential");
      const consumerContext = yield* Layer.buildWithScope(layer, consumerScope);
      const finish = yield* Effect.cached(Scope.close(consumerScope, Exit.void));
      return yield* execute(Effect.void).pipe(
        Effect.provide(consumerContext),
        Effect.provideService(FinishCommandProgress, finish),
      );
    }),
  );
