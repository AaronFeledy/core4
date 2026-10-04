import { Cause, Clock, Effect, Exit, Layer, References, Result, Schema, Tracer } from "effect";

import { JqExpressionError } from "@lando/sdk/errors";
import type { StreamFrameSchema } from "@lando/sdk/schema";
import type { EventService, Renderer } from "@lando/sdk/services";

import type { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import * as EnvSecretStore from "@lando/engine/services/secret-store";
import { RedactionService } from "@lando/redaction/service";
import { shouldEmitHyperlinks } from "@lando/renderer/console-layout";
import { type RendererIO, createStdioRendererIO, onStdioBrokenPipe } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import { writeDiagnosticLine, writeResultLine } from "@lando/renderer/output";
import type { FormatSummaryOptions } from "@lando/renderer/summary";
import {
  type CliInvocationSnapshot,
  newInvocationId,
  runCommandLifecycle,
  withCommandEventService,
} from "./command-lifecycle";
import { CommandWarnings, makeCommandWarnings } from "./command-warnings";
import { dimBugReportDetails } from "./diagnostic-text";
import { renderFailureEvidence } from "./failure-evidence";
import { DEFAULT_RESULT_FORMAT, type ResultFormat, isEnvelopeResultFormat } from "./format-flags";
import { renderDeprecationDiagnostics } from "./renderer-deprecations";
import { type StreamOutputFrame, makeMachineResultEmitters } from "./renderer-machine-output";
import type { RendererMode } from "./renderer-selection";

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
  /** Host env snapshot used for OSC 8 capability (TERM, NO_COLOR). */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
  ctx !== undefined &&
  isDecoratedContext(ctx) &&
  shouldEmitHyperlinks({
    isTTY: ctx.isTTY,
    ...(ctx.env === undefined ? {} : { env: ctx.env }),
  });

/** Columns + before-paint redactor for {@link formatSummary}. */
export const summaryPaintOptions = (ctx?: RenderContext): FormatSummaryOptions => ({
  ...(ctx?.columns === undefined ? {} : { columns: ctx.columns }),
  ...(ctx?.redact === undefined ? {} : { redact: ctx.redact }),
});

export interface RunWithRendererHandlingOptions<A, R, RE> {
  readonly runtime: Layer.Layer<Exclude<R, EventService | Renderer | StreamFrameSink>, RE>;
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
  readonly plainTaskEvents?: "detail-only";
  readonly deprecationWarnings?: boolean;
  readonly suppressDeprecationDiagnostics?: boolean;
  readonly suppressInterruptionDiagnostics?: boolean;
  readonly render?: (value: A, ctx: RenderContext) => string | undefined;
  readonly successExitCode?: (value: A) => number | undefined;
  readonly failureExitCode?: (error: unknown) => number | undefined;
  readonly formatError: (error: unknown) => string;
  readonly setExitCode?: (code: number) => void;
  /**
   * Records the command's spans with this tracer. Without one, the CLI keeps
   * `References.TracerEnabled` false and records nothing.
   */
  readonly tracer?: Tracer.Tracer;
}

const EmptyCommandResultSchema = Schema.Struct({});

/**
 * Parents spans under a command stage without `Effect.withParentSpan`, which
 * would add the stage to rendered failure stacks.
 */
const withStageParent = <A, E, R>(effect: Effect.Effect<A, E, R>, span: Tracer.Span) =>
  Effect.provideService(effect, Tracer.ParentSpan, span);

/** Ends a lifecycle stage span once; later calls are no-ops. */
const makeStage = (name: "init" | "run" | "render") => {
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
      if (span === undefined || ended) return Effect.void;
      ended = true;
      const current = span;
      return Effect.map(Clock.currentTimeNanos, (now) => current.end(now, exit));
    });
  return { start, end };
};

const taggedFailureFromCause = (cause: Cause.Cause<unknown>): unknown => {
  if (cause.reasons.length > 1) return new Error(Cause.pretty(cause), { cause });
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === "Some") return failure.value;
  const defect = Cause.findDefect(cause);
  if (Result.isSuccess(defect)) return defect.success;
  if (Cause.hasInterruptsOnly(cause)) return "All fibers interrupted without errors.";
  return Cause.pretty(cause);
};

// allow: SIZE_OK — command rendering state machine shares lifecycle, emitters, and failure policy in one closure.
export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const { landoRenderer } = await import("./renderer/bundled-renderers");
  const io = options.io ?? createStdioRendererIO();
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
  // Subscribe before command writes; raceFirst waits for interrupted scope finalizers.
  const commandEffect = Effect.raceFirst(brokenPipeSignal, effect);
  const renderContext: RenderContext = {
    mode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    columns: io.terminalColumns,
    isTTY: io.isTTY === true,
    env: process.env,
  };
  const rendererLayer = RendererOutput.layerServiceForMode(options.rendererMode, landoRenderer, io);
  const envelopeFormat = isEnvelopeResultFormat(renderContext.format);
  const commandWarnings = makeCommandWarnings(envelopeFormat);
  const commandWarningsLayer = Layer.succeed(CommandWarnings, commandWarnings);
  const failureDiagnosticsLayer = Layer.mergeAll(
    rendererLayer,
    RedactionService.layer.pipe(Layer.provide(EnvSecretStore.layer)),
  );
  // Frame transport is JSON only. A YAML run emits the terminal envelope alone.
  const framedJson = options.streaming !== undefined && renderContext.format === "json";
  const liveStreaming = options.streamingMode === "live";
  const streamFrameSinkLayer = RendererOutput.layerStreamFrameSink(renderContext.format).pipe(
    Layer.provide(
      Layer.merge(rendererLayer, RedactionService.layer.pipe(Layer.provide(EnvSecretStore.layer))),
    ),
  );
  const commandLayer = (
    liveStreaming
      ? Layer.mergeAll(options.runtime, rendererLayer, streamFrameSinkLayer, commandWarningsLayer)
      : Layer.mergeAll(options.runtime, rendererLayer, commandWarningsLayer)
  ) as Layer.Layer<R, RE>;
  const command = options.command ?? "cli:unknown";
  // Resolve the invocation id once so the root span and lifecycle events agree.
  const invocation =
    options.invocation === undefined
      ? undefined
      : { ...options.invocation, invocationId: options.invocation.invocationId ?? newInvocationId() };
  const initStage = makeStage("init");
  const renderStage = makeStage("render");
  const runCommand = Effect.useSpan("CommandLifecycle.run", (span) => withStageParent(commandEffect, span));
  const program = Effect.gen(function* () {
    const initSpan = yield* initStage.start;
    const resultSchema = options.resultSchema ?? EmptyCommandResultSchema;
    const { emitJsonResult, emitStreamResult, replayBufferedEvents, emitStreamingSuccess } =
      makeMachineResultEmitters<A>({
        command,
        resultSchema,
        commandWarnings,
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
        const failure = Cause.findErrorOption(cause);
        if (failure._tag === "Some" && failure.value instanceof JqExpressionError) {
          setExitCode(2);
          return;
        }
        setExitCode(failure._tag === "Some" ? (options.failureExitCode?.(failure.value) ?? 1) : 1);
      });
    const renderFailure = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
      const error = yield* renderFailureEvidence(taggedFailureFromCause(cause));
      if (envelopeFormat) {
        const outcome = {
          _tag: "failure",
          error,
        } as const;
        const emit = (next: typeof outcome) => (framedJson ? emitStreamResult(next) : emitJsonResult(next));
        if (framedJson && !liveStreaming) yield* replayBufferedEvents();
        const emitted = yield* emit(outcome).pipe(Effect.result);
        if (emitted._tag === "Failure") {
          if (!(emitted.failure instanceof JqExpressionError)) {
            return yield* Effect.fail(emitted.failure);
          }
          yield* emit({ _tag: "failure", error: emitted.failure });
          setExitCode(2);
          return;
        }
        yield* setFailureExitCode(cause);
        return;
      }
      let message = options.formatError(error);
      const redaction = yield* Effect.serviceOption(RedactionService);
      if (redaction._tag === "Some") {
        const redactor = yield* redaction.value.forProfile("secrets", { sourceEnv: process.env });
        message = redactor.redactString(message);
      }
      if (isDecoratedContext(renderContext)) message = dimBugReportDetails(message);
      yield* writeDiagnosticLine(message);
      yield* setFailureExitCode(cause);
    });
    const executeCommand = Effect.gen(function* () {
      if (invocation === undefined) yield* initStage.end(Exit.void);
      const commandExit =
        invocation === undefined
          ? yield* Effect.exit(runCommand)
          : yield* runCommandLifecycle(runCommand, {
              invocation,
              onInitialized: initStage.end(Exit.void),
              ...(options.successExitCode === undefined ? {} : { successExitCode: options.successExitCode }),
              ...(options.failureExitCode === undefined ? {} : { failureExitCode: options.failureExitCode }),
              ...(options.suppressInterruptionDiagnostics === true ? { interruptionExitCode: 0 } : {}),
            });
      if (invocation !== undefined) {
        // Terminal subscribers publish to the command-scoped renderer before its scope closes.
        yield* Effect.yieldNow;
      }
      const renderSpan = yield* renderStage.start;
      return yield* withStageParent(renderCommandExit(commandExit), renderSpan);
    });
    const renderCommandExit = Effect.fnUntraced(function* (commandExit: Exit.Exit<A, unknown>) {
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
      yield* applySuccessExitCode(commandExit.value);
      if (liveStreaming) {
        if (envelopeFormat) {
          const tokens = options.redactionTokens?.(commandExit.value) ?? [];
          // A live run already wrote frames, so its terminal result stays a frame
          // under JSON even when the command declares no frame schema. YAML has no
          // frame transport and emits the envelope document alone.
          const emitTerminal =
            renderContext.format === "json"
              ? emitStreamResult({ _tag: "success", value: commandExit.value }, tokens)
              : emitJsonResult({ _tag: "success", value: commandExit.value }, tokens);
          yield* emitTerminal.pipe(Effect.catchCause((cause) => renderFailure(cause)));
        }
        return { _tag: "handled-success" } as const;
      }
      if (framedJson) {
        yield* emitStreamingSuccess(commandExit.value).pipe(
          Effect.catchCause((cause) => renderFailure(cause)),
        );
        return { _tag: "handled-success" } as const;
      }
      return { _tag: "success", value: commandExit.value } as const;
    });
    const applySuccessExitCode = (value: A) =>
      Effect.sync(() => {
        const code = options.successExitCode?.(value);
        if (code !== undefined && code !== 0) setExitCode(code);
      });
    let eventConsumerLayer: Layer.Layer<never, never, EventService> | undefined;
    if (!(framedJson && !liveStreaming)) {
      if (!envelopeFormat) {
        eventConsumerLayer = RendererOutput.layerEventConsumerForMode(options.rendererMode, io, {
          landoRenderer,
          ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
        });
      } else {
        eventConsumerLayer = RendererOutput.layerNotificationConsumerForMode(
          options.rendererMode,
          landoRenderer,
          io,
        );
      }
    }
    const executeWithEventConsumer =
      eventConsumerLayer === undefined
        ? executeCommand
        : executeCommand.pipe(Effect.provide(eventConsumerLayer));
    // Build the command runtime in its own memo map. Effect 4 otherwise reuses the
    // diagnostic fallback's `RedactionService.layer`, bound to the env-only secret
    // store, and secrets from the runtime's own store would render unredacted.
    const commandOutcome = yield* Effect.exit(
      withCommandEventService(executeWithEventConsumer).pipe(
        Effect.provide(Layer.provide(commandLayer, Layer.succeed(Tracer.ParentSpan, initSpan)), {
          local: true,
        }),
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
            { _tag: "success", value: commandOutcome.value.value },
            options.redactionTokens?.(commandOutcome.value.value) ?? [],
          ).pipe(Effect.catchCause((cause) => renderFailure(cause)));
          return;
        }
        const value = commandOutcome.value.value;
        const redaction = yield* Effect.serviceOption(RedactionService);
        const redactor =
          redaction._tag === "Some"
            ? yield* redaction.value.forProfile("secrets", {
                sourceEnv: process.env,
                redactionTokens: options.redactionTokens?.(value) ?? [],
              })
            : undefined;
        // Redact command/result fields before the formatter paints SGR. Rewriting
        // an already-styled string can splice `[redacted]` into CSI parameters.
        const displayValue = redactor === undefined ? value : (redactor.redactValue(value) as A);
        const paintContext: RenderContext = {
          ...renderContext,
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
        program.pipe(Effect.onExit((exit) => Effect.andThen(initStage.end(exit), renderStage.end(exit)))),
        span,
      ),
  );
  const diagnosedProgram = tracedProgram.pipe(Effect.provide(failureDiagnosticsLayer));
  const exit = await Effect.runPromiseExit(
    options.tracer === undefined
      ? diagnosedProgram.pipe(Effect.provideService(References.TracerEnabled, false))
      : diagnosedProgram.pipe(
          Effect.provideService(Tracer.Tracer, options.tracer),
          Effect.provideService(References.TracerEnabled, true),
        ),
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause), { cause: exit.cause });
};
