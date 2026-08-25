import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { JqExpressionError } from "@lando/sdk/errors";
import type { StreamFrameSchema } from "@lando/sdk/schema";
import type { EventService, Renderer } from "@lando/sdk/services";

import type { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { SecretStoreLive } from "@lando/engine/services/secret-store";
import { RedactionService, RedactionServiceLive } from "@lando/redaction/service";
import { type RendererIO, createStdioRendererIO } from "@lando/renderer/io";
import {
  makeRendererEventConsumerLiveForMode,
  makeRendererNotificationConsumerLiveForMode,
  makeRendererServiceLiveForMode,
  makeStreamFrameSinkLive,
  writeDiagnosticLine,
  writeResultLine,
} from "@lando/renderer/output";
import type { FormatSummaryOptions } from "@lando/renderer/summary";
import {
  type CliInvocationSnapshot,
  runCommandLifecycle,
  withCommandEventService,
} from "./command-lifecycle";
import { CommandWarnings, makeCommandWarnings } from "./command-warnings";
import { dimBugReportDetails } from "./diagnostic-text";
import { DEFAULT_RESULT_FORMAT, type ResultFormat } from "./format-flags";
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
  /** Exact-value redactor for summary fields; apply before paint, never after. */
  readonly redact?: (text: string) => string;
}

/** Decorated grouped summaries apply only in the default `lando` renderer on a TTY. */
export const isDecoratedContext = (ctx?: RenderContext): boolean =>
  ctx?.mode === "lando" && ctx.isTTY === true;

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
  readonly resultSchema?: Schema.Schema.AnyNoContext;
  readonly streaming?: StreamFrameSchema;
  readonly streamingMode?: "live";
  readonly streamFrames?: (value: A) => ReadonlyArray<StreamOutputFrame>;
  readonly redactionTokens?: (value: A) => ReadonlyArray<string>;
  readonly projectResultKeys?: readonly string[];
  readonly jqExpression?: string;
  readonly io?: RendererIO;
  readonly renderEvents?: boolean;
  readonly plainTaskEvents?: "detail-only";
  readonly deprecationWarnings?: boolean;
  readonly suppressDeprecationDiagnostics?: boolean;
  readonly suppressInterruptionDiagnostics?: boolean;
  readonly render?: (value: A, ctx: RenderContext) => string | undefined;
  readonly successExitCode?: (value: A) => number | undefined;
  readonly failureExitCode?: (error: unknown) => number | undefined;
  readonly formatError: (error: unknown) => string;
  readonly setExitCode?: (code: number) => void;
}

const EmptyCommandResultSchema = Schema.Struct({});

const taggedFailureFromCause = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") return failure.value;
  const defect = Cause.dieOption(cause);
  if (defect._tag === "Some") return defect.value;
  return Cause.pretty(cause);
};

export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const { landoRenderer } = await import("./renderer/bundled-renderers");
  const io = options.io ?? createStdioRendererIO();
  const renderContext: RenderContext = {
    mode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    columns: io.terminalColumns,
    isTTY: io.isTTY === true,
  };
  const rendererLayer = makeRendererServiceLiveForMode(options.rendererMode, landoRenderer, io);
  const commandWarnings = makeCommandWarnings(renderContext.format === "json");
  const commandWarningsLayer = Layer.succeed(CommandWarnings, commandWarnings);
  const failureDiagnosticsLayer = Layer.mergeAll(
    rendererLayer,
    RedactionServiceLive.pipe(Layer.provide(SecretStoreLive)),
  );
  const streamingJson = options.streaming !== undefined && renderContext.format === "json";
  const liveStreaming = options.streamingMode === "live";
  const streamFrameSinkLayer = makeStreamFrameSinkLive(renderContext.format).pipe(
    Layer.provide(Layer.merge(rendererLayer, RedactionServiceLive.pipe(Layer.provide(SecretStoreLive)))),
  );
  const commandLayer = (
    liveStreaming
      ? Layer.mergeAll(options.runtime, rendererLayer, streamFrameSinkLayer, commandWarningsLayer)
      : Layer.mergeAll(options.runtime, rendererLayer, commandWarningsLayer)
  ) as Layer.Layer<R, RE>;
  const program = Effect.gen(function* () {
    const command = options.command ?? "cli:unknown";
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
        const failure = Cause.failureOption(cause);
        if (failure._tag === "Some" && failure.value instanceof JqExpressionError) {
          setExitCode(2);
          return;
        }
        setExitCode(failure._tag === "Some" ? (options.failureExitCode?.(failure.value) ?? 1) : 1);
      });
    const renderFailure = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const error = taggedFailureFromCause(cause);
        if (renderContext.format === "json") {
          const outcome = {
            _tag: "failure",
            error,
          } as const;
          const emit = (next: typeof outcome) =>
            options.streaming !== undefined ? emitStreamResult(next) : emitJsonResult(next);
          if (options.streaming !== undefined && !liveStreaming) yield* replayBufferedEvents();
          const emitted = yield* emit(outcome).pipe(Effect.either);
          if (emitted._tag === "Left") {
            if (!(emitted.left instanceof JqExpressionError)) {
              return yield* Effect.fail(emitted.left);
            }
            yield* emit({ _tag: "failure", error: emitted.left });
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
      const commandExit =
        options.invocation === undefined
          ? yield* Effect.exit(effect)
          : yield* runCommandLifecycle(effect, {
              invocation: options.invocation,
              ...(options.successExitCode === undefined ? {} : { successExitCode: options.successExitCode }),
              ...(options.failureExitCode === undefined ? {} : { failureExitCode: options.failureExitCode }),
              ...(options.suppressInterruptionDiagnostics === true ? { interruptionExitCode: 0 } : {}),
            });
      if (options.invocation !== undefined) {
        // Terminal subscribers publish to the command-scoped renderer before its scope closes.
        yield* Effect.yieldNow();
      }
      if (
        options.suppressInterruptionDiagnostics === true &&
        Exit.isFailure(commandExit) &&
        Cause.isInterruptedOnly(commandExit.cause)
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
        if (renderContext.format === "json") {
          yield* emitStreamResult(
            { _tag: "success", value: commandExit.value },
            options.redactionTokens?.(commandExit.value) ?? [],
          ).pipe(Effect.catchAllCause((cause) => renderFailure(cause)));
        }
        return { _tag: "handled-success" } as const;
      }
      if (streamingJson) {
        yield* emitStreamingSuccess(commandExit.value).pipe(
          Effect.catchAllCause((cause) => renderFailure(cause)),
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
    if (!(streamingJson && !liveStreaming)) {
      if (options.renderEvents === true) {
        eventConsumerLayer = makeRendererEventConsumerLiveForMode(options.rendererMode, io, {
          landoRenderer,
          ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
        });
      } else {
        eventConsumerLayer = makeRendererNotificationConsumerLiveForMode(
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
    const commandOutcome = yield* Effect.exit(
      withCommandEventService(executeWithEventConsumer).pipe(Effect.provide(commandLayer)),
    );
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
    if (renderContext.format === "json") {
      yield* emitJsonResult(
        { _tag: "success", value: commandOutcome.value.value },
        options.redactionTokens?.(commandOutcome.value.value) ?? [],
      ).pipe(Effect.catchAllCause((cause) => renderFailure(cause)));
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
  });
  await Effect.runPromise(program.pipe(Effect.provide(failureDiagnosticsLayer)));
};
