import { Cause, Effect, Exit, Layer, Schema } from "effect";

import type { StreamFrameSchema } from "@lando/sdk/schema";
import type { EventService, Renderer } from "@lando/sdk/services";

import { RedactionService, RedactionServiceLive } from "../redaction/service.ts";
import { SecretStoreLive } from "../services/secret-store.ts";
import {
  type CliInvocationSnapshot,
  runCommandLifecycle,
  withCommandEventService,
} from "./command-lifecycle.ts";
import { CommandWarnings, makeCommandWarnings } from "./command-warnings.ts";
import { DEFAULT_RESULT_FORMAT, type ResultFormat } from "./format-flags.ts";
import { renderDeprecationDiagnostics } from "./renderer-deprecations.ts";
import { type StreamOutputFrame, makeMachineResultEmitters } from "./renderer-machine-output.ts";
import {
  makeRendererEventConsumerLiveForMode,
  makeRendererNotificationConsumerLiveForMode,
  makeRendererServiceLiveForMode,
  makeStreamFrameSinkLive,
  writeDiagnosticLine,
  writeResultLine,
} from "./renderer-output.ts";
import type { RendererMode } from "./renderer-selection.ts";
import { type RendererIO, createStdioRendererIO } from "./renderer/io.ts";
import type { StreamFrameSink } from "./stream-frame-sink.ts";

export {
  type RendererEventConsumerOptions,
  emitOptionalStderr,
  emitOptionalStdout,
  makeRendererEventConsumerLiveForMode,
  makeRendererServiceLiveForMode,
  writeDiagnosticLine,
  writeResultLine,
  writeStdout,
} from "./renderer-output.ts";
export {
  type ResolveCliDeprecationWarningsOptions,
  type ResolveCliDeprecationWarningsResult,
  resolveCliDeprecationWarnings,
} from "./renderer-deprecations.ts";
export type { StreamOutputFrame } from "./renderer-machine-output.ts";
export {
  type ResolveCliRendererModeOptions,
  readConfigRendererValue,
  resolveCliRendererMode,
} from "./renderer-mode-resolution.ts";

export interface RenderContext {
  readonly mode: RendererMode;
  readonly format: ResultFormat;
  readonly columns: number | undefined;
  readonly isTTY: boolean;
}

/** Decorated grouped summaries apply only in the default `lando` renderer on a TTY. */
export const isDecoratedContext = (ctx?: RenderContext): boolean =>
  ctx?.mode === "lando" && ctx.isTTY === true;

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

export const runWithRendererHandling = async <A, E, R, RE>(
  effect: Effect.Effect<A, E, R>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
): Promise<void> => {
  const io = options.io ?? createStdioRendererIO();
  const renderContext: RenderContext = {
    mode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    columns: io.terminalColumns,
    isTTY: io.isTTY === true,
  };
  const rendererLayer = makeRendererServiceLiveForMode(options.rendererMode, io);
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
        setExitCode(failure._tag === "Some" ? (options.failureExitCode?.(failure.value) ?? 1) : 1);
      });
    const applySuccessExitCode = (value: A) =>
      Effect.sync(() => {
        const code = options.successExitCode?.(value);
        if (code !== undefined && code !== 0) setExitCode(code);
      });
    const renderFailure = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const failure = Cause.failureOption(cause);
        if (renderContext.format === "json") {
          const outcome = {
            _tag: "failure",
            error: failure._tag === "Some" ? failure.value : Cause.pretty(cause),
          } as const;
          if (options.streaming !== undefined) {
            if (!liveStreaming) yield* replayBufferedEvents();
            yield* emitStreamResult(outcome);
          } else {
            yield* emitJsonResult(outcome);
          }
          yield* setFailureExitCode(cause);
          return;
        }
        let message = failure._tag === "Some" ? options.formatError(failure.value) : Cause.pretty(cause);
        const redaction = yield* Effect.serviceOption(RedactionService);
        if (redaction._tag === "Some") {
          const redactor = yield* redaction.value.forProfile("secrets", { sourceEnv: process.env });
          message = redactor.redactString(message);
        }
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
          );
        }
        return { _tag: "handled-success" } as const;
      }
      if (streamingJson) {
        yield* emitStreamingSuccess(commandExit.value);
        return { _tag: "handled-success" } as const;
      }
      return { _tag: "success", value: commandExit.value } as const;
    });
    let eventConsumerLayer: Layer.Layer<never, never, EventService> | undefined;
    if (!(streamingJson && !liveStreaming)) {
      if (options.renderEvents === true) {
        eventConsumerLayer = makeRendererEventConsumerLiveForMode(options.rendererMode, io, {
          ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
        });
      } else {
        eventConsumerLayer = makeRendererNotificationConsumerLiveForMode(options.rendererMode, io);
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
      yield* emitJsonResult({ _tag: "success", value: commandOutcome.value.value });
      return;
    }
    const rendered = options.render?.(commandOutcome.value.value, renderContext);
    if (rendered !== undefined && rendered.length > 0) yield* writeResultLine(rendered);
  });
  await Effect.runPromise(program.pipe(Effect.provide(failureDiagnosticsLayer)));
};
