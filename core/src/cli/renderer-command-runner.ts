/**
 * The in-scope half of a command run.
 *
 * Builds the command's runtime, runs the command through its lifecycle with
 * the route's event consumer and live sink, captures the run's deprecation uses
 * and the command's own human render, then closes the runtime and settles the
 * run with that teardown. Nothing here writes the terminal document.
 */

import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { GlobalConfigSnapshot } from "@lando/engine/services/config";
import { EventCommitObserver, EventPublicationObserver } from "@lando/engine/services/event-service";
import type { RedactionService } from "@lando/redaction/service";
import type { RendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import { type CompletedCommandResult, resolveCommandCompletion } from "@lando/sdk/command-result";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { RendererContribution } from "@lando/sdk/renderer";
import type { Redactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent, type Renderer, StreamFrameSink } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Exit, Layer, Option, Schema, Scope, Tracer } from "effect";
import { ChildOutput, type ChildOutputPolicy } from "./child-output.ts";
import { commandInterruptionExitCode } from "./command-interruption";
import {
  type CliInvocationSnapshot,
  runCommandLifecycle,
  withCommandEventService,
} from "./command-lifecycle";
import { finishCommandProgress } from "./command-progress";
import { type CommandRun, type SettledCommand, settleCommandRun } from "./command-settlement";
import { type CommandStage, withStageParent } from "./command-stage";
import type { CommandWarningsShape } from "./command-warnings";
import { DEFAULT_RESULT_FORMAT } from "./format-flags";
import { interruptOnAbort } from "./interrupt-on-abort";
import type { OutputRouting } from "./output-routing";
import { captureRender } from "./render-capture";
import type { RunWithRendererHandlingOptions } from "./renderer-boundary";
import { collectInvocationDeprecations, renderDeprecationDiagnostics } from "./renderer-deprecations";
import { withEventConsumer } from "./renderer-event-consumer";

const isMessageWarnEvent = Schema.is(
  Schema.Union([Schema.toEncoded(MessageWarnEvent), Schema.toType(MessageWarnEvent)]),
);

/** Where one run's output goes, resolved once per run. */
export interface RunOutput {
  readonly routing: OutputRouting;
  /** The invocation's own IO. */
  readonly realIO: RendererIO;
  /** What renderers write to: `realIO`, with machine stdout moved to stderr for a payload command. */
  readonly io: RendererIO;
  readonly machineStdout: boolean;
  /** The command writes its payload to stdout itself; machine output moves to stderr. */
  readonly payloadStdout: boolean;
  /** Child process bytes reach the terminal: a human result under a human renderer. */
  readonly humanChildOutput: boolean;
}

export interface CommandScope<A, R, RE> {
  readonly options: RunWithRendererHandlingOptions<A, R, RE>;
  readonly command: string;
  readonly invocation: CliInvocationSnapshot | undefined;
  readonly output: RunOutput;
  readonly commandLayer: Layer.Layer<R, RE>;
  readonly childOutput: ChildOutputPolicy;
  readonly commandWarnings: CommandWarningsShape;
  readonly landoRenderer: RendererContribution;
  readonly stages: { readonly init: CommandStage; readonly render: CommandStage };
  readonly brokenPipe: () => boolean;
  readonly frameRedactor: Effect.Effect<Redactor, never, RedactionService>;
  readonly encodeEventFrame: (event: LandoEvent, redactor: Redactor) => Effect.Effect<string>;
  readonly errorExitCode: (error: unknown) => number;
  /** The command's own exit, recorded for tracing before the run concludes. */
  readonly onCommandExit: (exit: Exit.Exit<unknown, unknown>) => void;
}

/** Runs the command in its runtime scope, closes that scope, and settles the run with the teardown. */
export const runCommandInScope = <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  scope: CommandScope<A, R, RE>,
  initSpan: Tracer.Span,
) => {
  const { options, command, invocation, output, commandWarnings, stages } = scope;
  const { routing, machineStdout } = output;
  const commandEffect = interruptOnAbort(effect, options.signal).pipe(
    Effect.provideService(ChildOutput, scope.childOutput),
    Effect.withErrorReporting({ defectsOnly: true }),
  );
  let finishStream: Effect.Effect<void> = Effect.void;
  const runCommand = Effect.useSpan("CommandLifecycle.run", (span) =>
    withStageParent(
      commandEffect.pipe(Effect.scoped, Effect.ensuring(Effect.suspend(() => finishStream))),
      span,
    ),
  );
  const concludeRun = Effect.fnUntraced(function* (
    commandExit: Exit.Exit<CompletedCommandResult<A>, unknown>,
  ): Effect.fn.Return<CommandRun<A>, unknown, R | Renderer | RedactionService> {
    if (Exit.isFailure(commandExit) && Cause.hasInterruptsOnly(commandExit.cause)) {
      if (scope.brokenPipe()) return { _tag: "silent", reason: "broken-pipe" };
      if (options.suppressInterruptionDiagnostics === true) return { _tag: "silent", reason: "interruption" };
    }
    const deprecations = yield* collectInvocationDeprecations;
    if (options.suppressDeprecationDiagnostics !== true) {
      yield* renderDeprecationDiagnostics(deprecations, options.deprecationWarnings ?? true);
    }
    if (Exit.isFailure(commandExit)) return { _tag: "failed", cause: commandExit.cause, deprecations };
    const completed = commandExit.value;
    if (machineStdout && options.documentOutput !== true)
      return { _tag: "completed", completed, deprecations };
    const rendered =
      !machineStdout && options.renderEffect !== undefined
        ? yield* captureRender(
            options.renderEffect(completed),
            options.rendererMode,
            scope.landoRenderer,
            output.io,
          )
        : undefined;
    const proxyDefaultDomain = yield* resolveProxyDefaultDomain;
    return {
      _tag: "completed",
      completed,
      deprecations,
      ...(proxyDefaultDomain === undefined ? {} : { proxyDefaultDomain }),
      ...(rendered === undefined ? {} : { rendered }),
    };
  });
  const executeCommand = Effect.fnUntraced(function* (finishFrames: Effect.Effect<void>) {
    if (invocation === undefined) yield* stages.init.end(Exit.void);
    const commandExit =
      invocation === undefined
        ? yield* Effect.exit(
            runCommand.pipe(
              Effect.map((value) => resolveCommandCompletion(command, value, options.completion)),
            ),
          )
        : yield* runCommandLifecycle(runCommand, {
            invocation,
            onInitialized: stages.init.end(Exit.void),
            ...(options.completion === undefined ? {} : { completion: options.completion }),
            failureExitCode: scope.errorExitCode,
            interruptionExitCode: () =>
              options.suppressInterruptionDiagnostics === true
                ? 0
                : commandInterruptionExitCode(options.signal),
          });
    yield* finishFrames;
    yield* finishCommandProgress();
    scope.onCommandExit(commandExit);
    const renderSpan = yield* stages.render.start;
    return yield* withStageParent(concludeRun(commandExit), renderSpan);
  });
  const flushConfigWarnings = Effect.gen(function* () {
    const snapshot = yield* Effect.serviceOption(GlobalConfigSnapshot);
    const events = yield* Effect.serviceOption(EventService);
    if (Option.isNone(snapshot) || Option.isNone(events)) return;
    for (const body of yield* snapshot.value.takeWarnings) {
      yield* events.value
        .publish(MessageWarnEvent.make({ body, timestamp: DateTime.nowUnsafe() }))
        .pipe(Effect.ignore);
    }
  });
  const executeWithLiveSink = (finishFrames: Effect.Effect<void>) =>
    Effect.andThen(
      flushConfigWarnings,
      routing.sink === "live"
        ? Effect.gen(function* () {
            const owner = yield* RendererOutput.makeStreamFrameSink(
              routing.stdout === "frames" ? "json" : (options.resultFormat ?? DEFAULT_RESULT_FORMAT),
            );
            finishStream = owner.finish();
            return yield* executeCommand(finishFrames).pipe(
              Effect.provideService(StreamFrameSink, owner.sink),
            );
          })
        : routing.sink === "discard"
          ? executeCommand(finishFrames).pipe(
              Effect.provideService(StreamFrameSink, { emit: () => Effect.void }),
            )
          : executeCommand(finishFrames),
    );
  let observeProgress: ((event: LandoEvent) => void) | undefined;
  const executeWithEventConsumer = withEventConsumer(executeWithLiveSink, {
    routing,
    rendererMode: options.rendererMode,
    io: output.io,
    landoRenderer: scope.landoRenderer,
    signal: options.signal,
    commandWarnings,
    observeProgressWith: (observe) => {
      observeProgress = observe;
    },
    frameRedactor: scope.frameRedactor,
    encodeEventFrame: scope.encodeEventFrame,
  });
  const observeScenarioEvent = options.context?.observeEvent;
  const runInScope = (runtimeScope: Scope.Scope) =>
    Effect.gen(function* () {
      const runtimeContext = yield* interruptOnAbort(
        Layer.buildWithMemoMap(
          Layer.provide(scope.commandLayer, Layer.succeed(Tracer.ParentSpan, initSpan)),
          yield* Layer.makeMemoMap,
          runtimeScope,
        ),
        options.signal,
      );
      return yield* withCommandEventService(executeWithEventConsumer).pipe(Effect.provide(runtimeContext));
    }).pipe(
      Effect.provideService(EventCommitObserver, (event) => observeProgress?.(event)),
      Effect.provideService(EventPublicationObserver, (event) =>
        Effect.andThen(
          observeScenarioEvent === undefined ? Effect.void : Effect.sync(() => observeScenarioEvent(event)),
          machineStdout && isMessageWarnEvent(event)
            ? commandWarnings.add({ code: "LANDO_MESSAGE_WARN", message: event.body })
            : Effect.void,
        ),
      ),
      Effect.withErrorReporting({ defectsOnly: true }),
    );
  return Effect.gen(function* () {
    const runtimeScope = yield* Scope.make("sequential");
    const { runExit, teardownExit } = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runExit = yield* Effect.exit(restore(runInScope(runtimeScope)));
        const teardownExit = yield* Effect.exit(Scope.close(runtimeScope, runExit));
        return { runExit, teardownExit };
      }),
    );
    yield* stages.init.end(runExit);
    return settleCommandRun(runExit, teardownExit) satisfies SettledCommand<A>;
  });
};
