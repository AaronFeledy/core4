import {
  Cause,
  Clock,
  DateTime,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Option,
  References,
  Schema,
  Scope,
  Tracer,
} from "effect";

import { GlobalConfigSnapshot } from "@lando/engine/services/config";
import {
  type CompletedCommandResult,
  failureOutcomeFromCause,
  normalizeDefect,
  primaryFailureReason,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";
import { JqExpressionError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { CommandCompletion, StreamFrameSchema } from "@lando/sdk/schema";
import { EventService, Renderer } from "@lando/sdk/services";
import { commandFailureOutcome, commandInterruptionExitCode } from "./command-interruption";

import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { EventPublicationObserver } from "@lando/engine/services/event-service";
import { RedactionService, makeRedactionOwner } from "@lando/redaction/service";
import {
  type RendererIO,
  createStdioRendererIO,
  onStdioBrokenPipe,
  withStdioTerminalNewlines,
} from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import { writeDiagnosticLine, writeResultLine } from "@lando/renderer/output";
import type { FormatSummaryOptions } from "@lando/renderer/summary";
import {
  type CliInvocationSnapshot,
  newInvocationId,
  runCommandLifecycle,
  withCommandEventService,
} from "./command-lifecycle";
import { FinishCommandProgress, finishCommandProgress } from "./command-progress";
import { type CommandTraceCapture, formatCommandTrace } from "./command-tracer";
import { withCommandTracing } from "./command-tracing";
import { CommandWarnings, makeCommandWarnings } from "./command-warnings";
import { dimBugReportDetails } from "./diagnostic-text";
import { renderFailureEvidence } from "./failure-evidence";
import { DEFAULT_RESULT_FORMAT, type ResultFormat, isEnvelopeResultFormat } from "./format-flags";
import { interruptOnAbort } from "./interrupt-on-abort";
import { renderDeprecationDiagnostics } from "./renderer-deprecations";
import { startMachineEventConsumer } from "./renderer-machine-events";
import { type StreamOutputFrame, makeMachineResultEmitters } from "./renderer-machine-output";
import type { RendererMode } from "./renderer-selection";
import { ResultTerminal } from "./result-terminal";
import { recordCliDefect, renderTerminalFailure } from "./terminal-failure";
import { type TraceSelection, activeTrace } from "./trace-selection";

export {
  type ResolveCliDeprecationWarningsOptions,
  type ResolveCliDeprecationWarningsResult,
  resolveCliDeprecationWarnings,
} from "./renderer-deprecations";
export type { StreamOutputFrame } from "./renderer-machine-output";
export {
  type ConfigCliGlobals,
  type ResolveCliRendererModeOptions,
  readConfigCliGlobals,
  resolveCliRendererMode,
} from "./renderer-mode-resolution";

export interface RenderContext {
  readonly mode: RendererMode;
  readonly format: ResultFormat;
  readonly columns: number | undefined;
  readonly isTTY: boolean;
  readonly proxyDefaultDomain?: string;
  readonly noColor: boolean;
  /** Exact-value redactor for summary fields; apply before paint, never after. */
  readonly redact?: (text: string) => string;
}

/** Decorated grouped summaries apply only in the default `lando` renderer on a TTY. */
export const isDecoratedContext = (ctx?: RenderContext): boolean =>
  ctx?.mode === "lando" && ctx.isTTY === true;

/**
 * OSC 8 wraps existing labels only where decorated output already goes: the
 * default `lando` renderer on a TTY, with TERM not dumb and NO_COLOR unset.
 * `--renderer=plain` advertises `color: false`, so it stays escape-free.
 */
export const contextAllowsHyperlinks = (ctx?: RenderContext): boolean =>
  ctx !== undefined && isDecoratedContext(ctx) && !ctx.noColor;

/** Columns + before-paint redactor for {@link formatSummary}. */
export const summaryPaintOptions = (ctx?: RenderContext): FormatSummaryOptions => ({
  color: ctx?.noColor !== true,
  hyperlinks: contextAllowsHyperlinks(ctx),
  ...(ctx?.columns === undefined ? {} : { columns: ctx.columns }),
  ...(ctx?.redact === undefined ? {} : { redact: ctx.redact }),
});

export interface RunWithRendererHandlingOptions<A, R, RE> {
  readonly runtime: Layer.Layer<Exclude<R, EventService | Renderer>, RE>;
  readonly rendererMode: RendererMode;
  readonly resultFormat?: ResultFormat;
  readonly command?: string;
  readonly invocation?: CliInvocationSnapshot;
  readonly resultSchema?: Schema.Codec<unknown, unknown>;
  readonly streaming?: StreamFrameSchema;
  readonly streamingMode?: "live";
  readonly streamFrames?: (value: A) => ReadonlyArray<StreamOutputFrame>;
  readonly redactionTokens?: (value: A) => ReadonlyArray<string>;
  readonly projectResultKeys?: readonly string[];
  readonly jqExpression?: string;
  /** Resolved `LandoCommandSpec.documentOutput` match for this invocation. */
  readonly documentOutput?: boolean;
  readonly io?: RendererIO;
  readonly deprecationWarnings?: boolean;
  readonly suppressDeprecationDiagnostics?: boolean;
  readonly suppressInterruptionDiagnostics?: boolean;
  readonly signal?: AbortSignal;
  readonly render?: (value: A, ctx: RenderContext) => string | undefined;
  readonly renderEffect?: (completed: CompletedCommandResult<A>) => Effect.Effect<void, unknown, R>;
  readonly completion?: (value: A) => CommandCompletion;
  readonly failureExitCode?: (error: unknown) => number | undefined;
  readonly formatError: (
    failure: import("@lando/sdk/command-result").ProjectedFailure,
    redactor: import("@lando/sdk/secrets").Redactor,
  ) => string;
  readonly setExitCode?: (code: number) => void;
  /**
   * Records the command's spans with this tracer. Without one, the CLI keeps
   * `References.TracerEnabled` false and records nothing.
   */
  readonly tracer?: Tracer.Tracer;
  readonly trace?: TraceSelection;
  readonly traceCapture?: CommandTraceCapture;
  readonly traceDisplay?: boolean;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly extraRedactionTokens?: ReadonlyArray<string>;
}

const EmptyCommandResultSchema = Schema.Struct({});
const isMessageWarnEvent = Schema.is(
  Schema.Union([Schema.toEncoded(MessageWarnEvent), Schema.toType(MessageWarnEvent)]),
);

/**
 * Parents spans under a command stage without `Effect.withParentSpan`, which
 * would add the stage to rendered failure stacks.
 */
const withStageParent = <A, E, R>(effect: Effect.Effect<A, E, R>, span: Tracer.Span) =>
  Effect.provideService(effect, Tracer.ParentSpan, span);

/** Ends a lifecycle stage span. Render may be revised after a formatter failure; other stages keep the first exit. */
const makeStage = (name: "init" | "run" | "render", revisable = false) => {
  let span: Tracer.Span | undefined;
  let ended = false;
  const start = Effect.suspend(() =>
    span === undefined
      ? Effect.map(Effect.makeSpan(`CommandLifecycle.${name}`), (made) => {
          span = made;
          return made;
        })
      : Effect.succeed(span),
  );
  const end = (exit: Exit.Exit<unknown, unknown>) =>
    Effect.suspend(() => {
      // Render can be closed once to fill the envelope, then again after a
      // fallible formatter (jq) fails. Other stages stay first-exit-wins.
      if (span === undefined || (ended && !revisable)) return Effect.void;
      ended = true;
      const current = span;
      return Effect.map(Clock.currentTimeNanos, (now) => current.end(now, exit));
    });
  return { start, end };
};

// allow: SIZE_OK — command rendering state machine shares lifecycle, emitters, and failure policy in one closure.
export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const owner = makeRedactionOwner();
  const sourceEnv = { ...(options.sourceEnv ?? process.env) };
  try {
    await runWithInvocationRedaction(effect, { ...options, sourceEnv }, owner.service);
  } catch (cause) {
    const redactor = await Effect.runPromise(owner.service.forProfile("secrets", { sourceEnv }));
    await renderTerminalFailure(Cause.isCause(cause) ? cause : Cause.die(cause), options, redactor);
  } finally {
    owner.dispose();
  }
};

const runWithInvocationRedaction = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
  redaction: RedactionService["Service"],
): Promise<void> => {
  const selection = options.trace ?? activeTrace();
  if (options.tracer === undefined && selection?.enabled === true) {
    return withCommandTracing(
      selection,
      (capture, redactionTokens) =>
        runWithInvocationRedaction(
          effect,
          {
            ...options,
            tracer: capture.tracer,
            traceCapture: capture,
            traceDisplay: selection.display,
            sourceEnv: selection.env,
            extraRedactionTokens: redactionTokens,
          },
          redaction,
        ),
      options.invocation?.flags,
      redaction,
    );
  }
  const sourceEnv = options.sourceEnv ?? process.env;
  const redactionLayer = Layer.succeed(RedactionService, redaction);
  const extraTokens = options.extraRedactionTokens ?? [];
  // Installed so command defects reach ErrorReporter. Display stays on formatError,
  // which is the bug-report renderer for pre-command failures.
  const reporter = ErrorReporter.make(() => undefined);
  const { landoRenderer } = await import("./renderer/bundled-renderers");
  const io = withStdioTerminalNewlines(
    options.io ?? createStdioRendererIO(undefined, undefined, undefined, { env: sourceEnv }),
    options.rendererMode !== "json" &&
      options.resultFormat !== "ndjson" &&
      !isEnvelopeResultFormat(options.resultFormat ?? DEFAULT_RESULT_FORMAT),
  );
  let brokenPipe = false;
  const brokenPipeSignal = Effect.callback<never>((resume) => {
    const unsubscribe = onStdioBrokenPipe((destination) => {
      if (destination !== "stdout") return;
      brokenPipe = true;
      unsubscribe();
      resume(Effect.interrupt);
    });
    return Effect.sync(unsubscribe);
  });
  const commandEffect = interruptOnAbort(effect, options.signal).pipe(
    Effect.withErrorReporting({ defectsOnly: true }),
  );
  const renderContext: RenderContext = {
    mode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    columns: io.stdoutColumns,
    isTTY: io.stdoutIsTTY === true,
    noColor: io.noColor === true,
  };
  const rendererLayer = RendererOutput.layerServiceForMode(options.rendererMode, landoRenderer, io);
  const envelopeFormat = isEnvelopeResultFormat(renderContext.format);
  const commandWarnings = makeCommandWarnings(envelopeFormat);
  const commandWarningsLayer = Layer.succeed(CommandWarnings, commandWarnings);
  const failureDiagnosticsLayer = Layer.mergeAll(rendererLayer, redactionLayer);
  // Frame transport is JSON only. A YAML run emits the terminal envelope alone.
  const framedJson = options.streaming !== undefined && renderContext.format === "json";
  const liveStreaming = options.streamingMode === "live";
  // Live sinks are for human formats and JSON data frames only. YAML collects into one envelope.
  const attachLiveSink = liveStreaming && renderContext.format !== "yaml";
  const liveJsonFrames = attachLiveSink && renderContext.format === "json";
  const commandLayer = Layer.mergeAll(
    options.runtime.pipe(Layer.provide(redactionLayer)),
    rendererLayer,
    commandWarningsLayer,
    redactionLayer,
  ) as Layer.Layer<R, RE>;
  const command = options.command ?? "cli:unknown";
  // Resolve the invocation id once so the root span and lifecycle events agree.
  const invocation =
    options.invocation === undefined
      ? undefined
      : { ...options.invocation, invocationId: options.invocation.invocationId ?? newInvocationId() };
  const initStage = makeStage("init");
  const renderStage = makeStage("render", true);
  let resultExit: Exit.Exit<unknown, unknown> = Exit.void;
  let completedExitCode: number | undefined;
  const capture = options.traceCapture;
  const finishTrace =
    capture === undefined
      ? undefined
      : Effect.gen(function* () {
          yield* renderStage.end(resultExit);
          return yield* capture.finish(resultExit);
        });
  let finishStream: Effect.Effect<void> = Effect.void;
  const runCommand = Effect.useSpan("CommandLifecycle.run", (span) =>
    withStageParent(
      commandEffect.pipe(Effect.scoped, Effect.ensuring(Effect.suspend(() => finishStream))),
      span,
    ),
  );
  const program = Effect.gen(function* () {
    const initSpan = yield* initStage.start;
    const resultSchema = options.resultSchema ?? EmptyCommandResultSchema;
    const {
      jsonRedactor,
      encodeEventFrame,
      emitJsonResult,
      emitStreamResult,
      replayBufferedEvents,
      emitStreamingSuccess,
    } = makeMachineResultEmitters<A>({
      command,
      resultSchema,
      commandWarnings,
      sourceEnv,
      extraRedactionTokens: extraTokens,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(capture === undefined ? {} : { onRedactor: capture.setRedactor }),
      ...(finishTrace === undefined ? {} : { trace: finishTrace }),
      ...(options.streamFrames === undefined ? {} : { streamFrames: options.streamFrames }),
      ...(options.redactionTokens === undefined ? {} : { redactionTokens: options.redactionTokens }),
      ...(options.projectResultKeys === undefined ? {} : { projectResultKeys: options.projectResultKeys }),
      ...(options.jqExpression === undefined ? {} : { jqExpression: options.jqExpression }),
      ...(envelopeFormat ? { resultFormat: renderContext.format as "json" | "yaml" } : {}),
    });
    const setExitCode = (code: number): void => {
      (
        options.setExitCode ??
        ((exitCode) => {
          process.exitCode = exitCode;
        })
      )(code);
    };
    const setFailureExitCode = (cause: Cause.Cause<unknown>) =>
      Effect.sync(() => {
        if (Cause.hasInterruptsOnly(cause)) {
          setExitCode(commandInterruptionExitCode(options.signal));
          return;
        }
        const primary = primaryFailureReason(cause);
        if (primary !== undefined && Cause.isDieReason(primary)) {
          setExitCode(1);
          return;
        }
        const failure = failureOutcomeFromCause(cause, normalizeDefect);
        if (failure.error instanceof JqExpressionError) {
          setExitCode(2);
          return;
        }
        setExitCode(options.failureExitCode?.(failure.error) ?? 1);
      });
    const renderFailure = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
      resultExit = Exit.failCause(cause);
      const defectRedactor = yield* redaction.forProfile("secrets", {
        sourceEnv,
        redactionTokens: extraTokens,
      });
      yield* recordCliDefect(cause, defectRedactor, io);
      const { error: primaryError, additionalErrors } = commandFailureOutcome(cause, options.signal);
      const error = yield* renderFailureEvidence(primaryError);
      if (envelopeFormat) {
        const outcome = {
          _tag: "failure",
          error,
          additionalErrors,
        } as const;
        const emit = (next: typeof outcome) =>
          framedJson || liveJsonFrames ? emitStreamResult(next) : emitJsonResult(next);
        if (framedJson && !attachLiveSink) yield* replayBufferedEvents();
        const emitted = yield* emit(outcome).pipe(Effect.result);
        if (emitted._tag === "Failure") {
          if (!(emitted.failure instanceof JqExpressionError)) {
            return yield* Effect.fail(emitted.failure);
          }
          yield* emit({ _tag: "failure", error: emitted.failure, additionalErrors: [] });
          setExitCode(2);
          return;
        }
        yield* setFailureExitCode(cause);
        return;
      }
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv, redactionTokens: extraTokens });
      let message = redactor.redactString(options.formatError({ error, additionalErrors }, redactor));
      // Failure notices (for example what an incomplete start left in place) follow the error.
      const notices = (yield* commandWarnings.failureNotices).map((notice) => redactor.redactString(notice));
      if (options.rendererMode === "lando" && io.isTTY === true) message = dimBugReportDetails(message);
      yield* writeDiagnosticLine(message);
      const renderer = yield* Renderer;
      for (const notice of notices) yield* renderer.message.warn(notice);
      yield* setFailureExitCode(cause);
    });
    const executeCommand = Effect.gen(function* () {
      if (invocation === undefined) yield* initStage.end(Exit.void);
      const commandExit =
        invocation === undefined
          ? yield* Effect.exit(
              runCommand.pipe(
                Effect.map((value) => resolveCommandCompletion(command, value, options.completion)),
              ),
            )
          : yield* runCommandLifecycle(runCommand, {
              invocation,
              onInitialized: initStage.end(Exit.void),
              ...(options.completion === undefined ? {} : { completion: options.completion }),
              ...(options.failureExitCode === undefined ? {} : { failureExitCode: options.failureExitCode }),
              interruptionExitCode: () =>
                options.suppressInterruptionDiagnostics === true
                  ? 0
                  : commandInterruptionExitCode(options.signal),
            });
      yield* finishCommandProgress();
      resultExit = commandExit;
      const renderSpan = yield* renderStage.start;
      return yield* withStageParent(renderCommandExit(commandExit), renderSpan);
    });
    const renderCommandExit = Effect.fnUntraced(function* (
      commandExit: Exit.Exit<CompletedCommandResult<A>, unknown>,
    ) {
      if (brokenPipe && Exit.isFailure(commandExit) && Cause.hasInterruptsOnly(commandExit.cause)) {
        return { _tag: "handled-failure" } as const;
      }
      if (
        options.suppressInterruptionDiagnostics === true &&
        Exit.isFailure(commandExit) &&
        Cause.hasInterruptsOnly(commandExit.cause)
      ) {
        return { _tag: "handled-failure" } as const;
      }
      if (options.suppressDeprecationDiagnostics !== true) {
        yield* renderDeprecationDiagnostics(options.deprecationWarnings ?? true);
      }
      if (Exit.isFailure(commandExit)) {
        yield* renderFailure(commandExit.cause);
        return { _tag: "handled-failure" } as const;
      }
      const completed = commandExit.value;
      const value = completed.value;
      completedExitCode = completed.exitCode;
      if (!envelopeFormat && options.renderEffect !== undefined) yield* options.renderEffect(completed);
      if (attachLiveSink) {
        if (envelopeFormat) {
          const tokens = options.redactionTokens?.(value) ?? [];
          // A live run already wrote frames, so its terminal result stays a frame
          // under JSON even when the command declares no frame schema. YAML has no
          // frame transport and emits the envelope document alone.
          const emitTerminal =
            renderContext.format === "json"
              ? emitStreamResult(completed, tokens)
              : emitJsonResult(completed, tokens);
          yield* emitTerminal.pipe(Effect.catchCause((cause) => renderFailure(cause)));
        }
        return { _tag: "handled-success" } as const;
      }
      if (framedJson) {
        yield* emitStreamingSuccess(value, completed).pipe(
          Effect.catchCause((cause) => renderFailure(cause)),
        );
        return { _tag: "handled-success" } as const;
      }
      const proxyDefaultDomain = yield* resolveProxyDefaultDomain;
      return { _tag: "success", value, completed, proxyDefaultDomain } as const;
    });
    let eventConsumerLayer: Layer.Layer<never, never, EventService> | undefined;
    if (!liveJsonFrames && !framedJson) {
      if (!envelopeFormat) {
        eventConsumerLayer = RendererOutput.layerEventConsumerForMode(options.rendererMode, io, {
          landoRenderer,
        });
      } else {
        eventConsumerLayer = RendererOutput.layerNotificationConsumerForMode(
          options.rendererMode,
          landoRenderer,
          io,
        );
      }
    }
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
    const executeWithLiveSink = Effect.andThen(
      flushConfigWarnings,
      attachLiveSink
        ? Effect.gen(function* () {
            const owner = yield* RendererOutput.makeStreamFrameSink(renderContext.format);
            finishStream = owner.finish();
            return yield* executeCommand.pipe(Effect.provideService(StreamFrameSink, owner.sink));
          })
        : executeCommand,
    );
    const executeWithEventConsumer = Effect.scoped(
      Effect.gen(function* () {
        if (liveJsonFrames) {
          const redactor = yield* jsonRedactor();
          const finish = yield* interruptOnAbort(
            startMachineEventConsumer(encodeEventFrame, redactor),
            options.signal,
          );
          return yield* executeWithLiveSink.pipe(
            Effect.provideService(FinishCommandProgress, interruptOnAbort(finish, options.signal)),
          );
        }
        if (eventConsumerLayer === undefined) return yield* executeWithLiveSink;
        const consumerScope = yield* Scope.fork(yield* Effect.scope, "sequential");
        const consumerContext = yield* Layer.buildWithScope(eventConsumerLayer, consumerScope);
        const finish = yield* Effect.cached(Scope.close(consumerScope, Exit.void));
        return yield* executeWithLiveSink.pipe(
          Effect.provide(consumerContext),
          Effect.provideService(FinishCommandProgress, finish),
        );
      }),
    );
    const commandOutcome = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const memoMap = yield* Layer.makeMemoMap;
          const runtimeContext = yield* interruptOnAbort(
            Layer.buildWithMemoMap(
              Layer.provide(commandLayer, Layer.succeed(Tracer.ParentSpan, initSpan)),
              memoMap,
              yield* Effect.scope,
            ),
            options.signal,
          );
          return yield* withCommandEventService(executeWithEventConsumer).pipe(
            Effect.provide(runtimeContext),
          );
        }),
      ).pipe(
        Effect.provideService(EventPublicationObserver, (event) =>
          envelopeFormat && isMessageWarnEvent(event)
            ? commandWarnings.add({ code: "LANDO_MESSAGE_WARN", message: event.body })
            : Effect.void,
        ),
        Effect.withErrorReporting({ defectsOnly: true }),
      ),
    );
    yield* initStage.end(commandOutcome);
    const renderSpan = yield* renderStage.start;
    yield* withStageParent(
      Effect.gen(function* () {
        if (Exit.isFailure(commandOutcome)) {
          yield* renderFailure(commandOutcome.cause);
          return;
        }
        if (commandOutcome.value._tag === "handled-failure") {
          return;
        }
        if (commandOutcome.value._tag === "handled-success") {
          return;
        }
        if (envelopeFormat && options.documentOutput !== true) {
          yield* emitJsonResult(
            commandOutcome.value.completed,
            options.redactionTokens?.(commandOutcome.value.value) ?? [],
          ).pipe(Effect.catchCause((cause) => renderFailure(cause)));
          return;
        }
        const value = commandOutcome.value.value;
        const redaction = yield* Effect.serviceOption(RedactionService);
        const redactor =
          redaction._tag === "Some"
            ? yield* redaction.value.forProfile("secrets", {
                sourceEnv,
                redactionTokens: [...extraTokens, ...(options.redactionTokens?.(value) ?? [])],
              })
            : undefined;
        if (redactor !== undefined) capture?.setRedactor(redactor);
        // Redact command/result fields before the formatter paints SGR. Rewriting
        // an already-styled string can splice `[redacted]` into CSI parameters.
        const displayValue = redactor === undefined ? value : (redactor.redactValue(value) as A);
        const paintContext: RenderContext = {
          ...renderContext,
          proxyDefaultDomain: commandOutcome.value.proxyDefaultDomain,
          ...(redactor === undefined ? {} : { redact: (text) => redactor.redactString(text) }),
        };
        const rendered = options.render?.(displayValue, paintContext);
        if (rendered !== undefined && rendered.length > 0) {
          const output =
            isDecoratedContext(paintContext) || redactor === undefined
              ? rendered
              : redactor.redactString(rendered);
          yield* writeResultLine(output);
        }
      }),
      renderSpan,
    );
  });
  const rootAttributes = {
    "lando.command.id": command,
    ...(invocation === undefined ? {} : { "lando.invocation.id": invocation.invocationId }),
  };
  const tracedProgram = Effect.useSpan(
    `lando ${command}`,
    { root: true, attributes: rootAttributes },
    (span) =>
      withStageParent(
        program.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* initStage.end(exit);
              yield* renderStage.end(resultExit);
              if (capture !== undefined) yield* capture.finish(Exit.isFailure(exit) ? exit : resultExit);
            }),
          ),
        ),
        span,
      ),
  );
  const diagnosedProgram = Effect.raceFirst(brokenPipeSignal, tracedProgram).pipe(
    Effect.provideService(ResultTerminal, {
      isTTY: renderContext.isTTY,
      columns: renderContext.columns,
      noColor: renderContext.noColor,
    }),
    Effect.withErrorReporting({ defectsOnly: true }),
    Effect.provide(Layer.merge(failureDiagnosticsLayer, ErrorReporter.layer([reporter]))),
  );
  const exit = await Effect.runPromiseExit(
    options.tracer === undefined
      ? diagnosedProgram.pipe(Effect.provideService(References.TracerEnabled, false))
      : diagnosedProgram.pipe(
          Effect.provideService(Tracer.Tracer, options.tracer),
          Effect.provideService(References.TracerEnabled, true),
        ),
  );
  if (Exit.isFailure(exit) && !brokenPipe) {
    const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv }));
    await renderTerminalFailure(exit.cause, options, redactor);
  } else if (Exit.isSuccess(resultExit) && completedExitCode !== undefined) {
    (
      options.setExitCode ??
      ((code) => {
        process.exitCode = code;
      })
    )(completedExitCode);
  }
  if (options.traceCapture !== undefined && options.traceDisplay === true && !envelopeFormat && !brokenPipe) {
    await Effect.runPromise(
      writeDiagnosticLine(
        (await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv }))).redactString(
          formatCommandTrace(options.traceCapture.snapshot()),
        ),
      ).pipe(Effect.provide(rendererLayer)),
    );
  }
};
