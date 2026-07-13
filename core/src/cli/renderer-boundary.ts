import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import type { DeprecationUse, StreamFrameSchema } from "@lando/sdk/schema";
import { ConfigService, DeprecationService, EventService, Renderer } from "@lando/sdk/services";

import { RedactionService, RedactionServiceLive } from "../redaction/service.ts";
import { ConfigServiceLive } from "../services/config.ts";
import { SecretStoreLive } from "../services/secret-store.ts";
import {
  type CliInvocationSnapshot,
  runCommandLifecycle,
  withCommandEventService,
} from "./command-lifecycle.ts";
import { CommandWarnings, makeCommandWarnings } from "./command-warnings.ts";
import { DEFAULT_RESULT_FORMAT, type ResultFormat } from "./format-flags.ts";
import {
  type RendererMode,
  type ResolveRendererModeResult,
  resolveRendererMode,
} from "./renderer-selection.ts";
import { landoRenderer } from "./renderer/bundled-renderers.ts";
import { type RendererIO, createStdioRendererIO } from "./renderer/io.ts";
import {
  makeJsonRendererLive,
  makeJsonRendererServiceLive,
  makePlainRendererLive,
  makePlainRendererServiceLive,
  makePlainTaskDetailRendererLive,
  makeVerboseRendererLive,
  makeVerboseRendererServiceLive,
} from "./renderer/runtime.ts";
import {
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
} from "./result-encode.ts";
import { StreamFrameSink, type StreamFrameSinkFrame } from "./stream-frame-sink.ts";

export const makeRendererServiceLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
): Layer.Layer<Renderer> => {
  switch (mode) {
    case "json":
      return makeJsonRendererServiceLive(io);
    case "plain":
      return makePlainRendererServiceLive(io);
    case "verbose":
      return makeVerboseRendererServiceLive(io);
    case "lando":
      return landoRenderer.makeService(io);
  }
};

export interface RendererEventConsumerOptions {
  readonly plainTaskEvents?: "detail-only";
}

export const makeRendererEventConsumerLiveForMode = (
  mode: RendererMode,
  io: RendererIO = createStdioRendererIO(),
  options: RendererEventConsumerOptions = {},
): Layer.Layer<never, never, EventService> => {
  switch (mode) {
    case "json":
      return makeJsonRendererLive(io);
    case "plain":
      return options.plainTaskEvents === "detail-only"
        ? makePlainTaskDetailRendererLive(io)
        : makePlainRendererLive(io);
    case "verbose":
      return makeVerboseRendererLive(io);
    case "lando":
      return landoRenderer.makeEventConsumer(io);
  }
};

const requireRenderer = Effect.serviceOption(Renderer).pipe(
  Effect.flatMap((option) =>
    Option.isNone(option)
      ? Effect.dieMessage("Renderer not provided at the CLI command boundary")
      : Effect.succeed(option.value),
  ),
);

export const writeStdout = (chunk: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(chunk)));

const optionalRenderer = Effect.serviceOption(Renderer);

export const emitOptionalStdout = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stdout(chunk) : Effect.void)),
  );

export const emitOptionalStderr = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stderr(chunk) : Effect.void)),
  );

export const writeResultLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));

const makeStreamFrameSinkLive = (
  format: ResultFormat,
): Layer.Layer<StreamFrameSink, never, Renderer | RedactionService> =>
  Layer.effect(
    StreamFrameSink,
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const redaction = yield* RedactionService;
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
      const emit = (frame: StreamFrameSinkFrame): Effect.Effect<void> =>
        Effect.gen(function* () {
          const streamFrameOptions = {
            chunk: frame.chunk,
            ...(frame.service === undefined ? {} : { service: frame.service }),
            ...(frame.source === undefined ? {} : { source: frame.source }),
            redactor,
          };
          if (format === "json") {
            const line =
              frame._tag === "stdout"
                ? yield* encodeStreamStdoutFrame(streamFrameOptions)
                : yield* encodeStreamStderrFrame(streamFrameOptions);
            yield* renderer.output.stdout(`${line}\n`);
            return;
          }
          const chunk = redactor.redactString(frame.chunk);
          const text =
            frame.service === undefined
              ? chunk
              : frame.source === undefined
                ? `${frame.service} ${frame._tag}: ${chunk}`
                : `${frame.service} ${frame._tag} [${frame.source}]: ${chunk}`;
          yield* renderer.output.stdout(`${text}\n`);
        });
      return { emit };
    }),
  );

export const writeDiagnosticLine = (text: string): Effect.Effect<void> =>
  requireRenderer.pipe(Effect.flatMap((renderer) => renderer.output.stderr(`${text}\n`)));

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
  readonly runtime: Layer.Layer<Exclude<R, Renderer | StreamFrameSink>, RE>;
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

export interface StreamOutputFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
}

const EmptyCommandResultSchema = Schema.Struct({});

export interface ResolveCliDeprecationWarningsOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolveCliDeprecationWarningsResult {
  readonly enabled: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
}

const NO_DEPRECATION_WARNINGS_FLAG = "--no-deprecation-warnings";

export const resolveCliDeprecationWarnings = (
  options: ResolveCliDeprecationWarningsOptions,
): ResolveCliDeprecationWarningsResult => {
  let disabledByFlag = false;
  let afterDoubleDash = false;
  const remainingArgv: string[] = [];
  for (const arg of options.argv) {
    if (afterDoubleDash) {
      remainingArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      remainingArgv.push(arg);
      continue;
    }
    if (arg === NO_DEPRECATION_WARNINGS_FLAG) {
      disabledByFlag = true;
      continue;
    }
    remainingArgv.push(arg);
  }
  return {
    enabled: !disabledByFlag && options.env.LANDO_DEPRECATION_WARNINGS !== "0",
    remainingArgv,
  };
};

const useCountText = (count: number): string => (count === 1 ? "once" : `${count} times`);

const surfaceLabel = (use: DeprecationUse): string => `${use.kind} ${use.id}`;

const warningText = (entry: DeprecationUse & { readonly count: number }): string => {
  const replacement =
    entry.notice.replacement === undefined ? "" : ` Replacement: ${entry.notice.replacement}.`;
  return `Deprecated ${surfaceLabel(entry)} (used ${useCountText(entry.count)}): ${entry.notice.note}${replacement}`;
};

const infoSummaryText = (entries: ReadonlyArray<DeprecationUse & { readonly count: number }>): string => {
  const surfaces = entries.map(
    (entry) => `${surfaceLabel(entry)} (${entry.count} ${entry.count === 1 ? "use" : "uses"})`,
  );
  return `Deprecated surfaces used: ${surfaces.join(", ")}.`;
};

const jsonDeprecationEventLine = (
  entry: DeprecationUse & { readonly count: number },
): Effect.Effect<string, never, RedactionService> => {
  const { count: _count, ...use } = entry;
  return Effect.gen(function* () {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    return yield* encodeStreamEventFrame({
      event: "deprecation-used",
      payload: { _tag: "deprecation-used", use },
      redactor,
    });
  });
};

type DeprecationServiceShape = typeof DeprecationService.Service;

const optionalDeprecationService = Effect.serviceOption(DeprecationService) as Effect.Effect<
  Option.Option<DeprecationServiceShape>,
  never,
  never
>;

const renderDeprecationDiagnostics = (
  enabled: boolean,
): Effect.Effect<void, never, Renderer | RedactionService> =>
  Effect.gen(function* () {
    const deprecations = yield* optionalDeprecationService;
    if (Option.isNone(deprecations)) return;
    const renderer = yield* Renderer;
    const summary = yield* deprecations.value.summary();
    if (summary.length === 0) return;

    if (renderer.id === "json") {
      for (const entry of summary) {
        const line = yield* jsonDeprecationEventLine(entry);
        yield* renderer.output.stderr(`${line}\n`);
      }
      return;
    }

    if (enabled) {
      for (const entry of summary) {
        if (entry.notice.severity === "warn") {
          yield* renderer.message.warn(warningText(entry)).pipe(Effect.catchAll(() => Effect.void));
        }
      }
    }

    const infoEntries = summary.filter((entry) => entry.notice.severity === "info");
    if (infoEntries.length > 0) {
      yield* renderer.message.info(infoSummaryText(infoEntries)).pipe(Effect.catchAll(() => Effect.void));
    }
  });

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
    const jsonRedactor = (redactionTokens: ReadonlyArray<string> = []) =>
      Effect.gen(function* () {
        const redaction = yield* Effect.serviceOption(RedactionService);
        if (redaction._tag === "Some")
          return yield* redaction.value.forProfile("secrets", {
            sourceEnv: process.env,
            redactionTokens,
          });
        return { redactString: (text: string) => text, redactValue: (value: unknown) => value };
      });
    const emitJsonResult = (outcome: Parameters<typeof encodeCommandResult>[0]["outcome"]) =>
      Effect.gen(function* () {
        const redactor = yield* jsonRedactor();
        const warnings = yield* commandWarnings.list;
        const line = yield* encodeCommandResult({ command, resultSchema, outcome, redactor, warnings });
        yield* writeResultLine(line);
      });
    const emitStreamResult = (
      outcome: Parameters<typeof encodeCommandResult>[0]["outcome"],
      redactionTokens: ReadonlyArray<string> = [],
    ) =>
      Effect.gen(function* () {
        const redactor = yield* jsonRedactor(redactionTokens);
        const warnings = yield* commandWarnings.list;
        const line = yield* encodeStreamResultFrame({
          command,
          resultSchema,
          outcome,
          redactor,
          warnings,
        });
        yield* writeResultLine(line);
      });
    const emitStreamingSuccess = (value: A) =>
      Effect.gen(function* () {
        const tokens = options.redactionTokens?.(value) ?? [];
        const redactor = yield* jsonRedactor(tokens);
        for (const frame of options.streamFrames?.(value) ?? []) {
          const streamFrameOptions = {
            chunk: frame.chunk,
            ...(frame.service === undefined ? {} : { service: frame.service }),
            ...(frame.source === undefined ? {} : { source: frame.source }),
            redactor,
          };
          const line =
            frame._tag === "stdout"
              ? yield* encodeStreamStdoutFrame(streamFrameOptions)
              : yield* encodeStreamStderrFrame(streamFrameOptions);
          yield* writeResultLine(line);
        }
        const events = yield* Effect.serviceOption(EventService).pipe(
          Effect.flatMap((service) =>
            Option.isSome(service) ? service.value.query("*") : Effect.succeed([]),
          ),
        );
        for (const event of events) {
          const tag = (event as { readonly _tag?: unknown })._tag;
          if (typeof tag !== "string") continue;
          const line = yield* encodeStreamEventFrame({ event: tag, payload: event, redactor });
          yield* writeResultLine(line);
        }
        yield* emitStreamResult({ _tag: "success", value }, tokens);
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
          if (options.streaming !== undefined) yield* emitStreamResult(outcome);
          else yield* emitJsonResult(outcome);
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
    const executeWithEventConsumer =
      options.renderEvents === true
        ? executeCommand.pipe(
            Effect.provide(
              makeRendererEventConsumerLiveForMode(options.rendererMode, io, {
                ...(options.plainTaskEvents === undefined
                  ? {}
                  : { plainTaskEvents: options.plainTaskEvents }),
              }),
            ),
          )
        : executeCommand;
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

export const readConfigRendererValue = async (): Promise<string | undefined> => {
  const value = await Effect.runPromise(
    Effect.flatMap(ConfigService, (config) => config.load).pipe(
      Effect.map((config) => config.renderer),
      Effect.provide(ConfigServiceLive),
      Effect.catchAll(() => Effect.succeed(undefined)),
    ),
  );
  return typeof value === "string" ? value : undefined;
};

export interface ResolveCliRendererModeOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly loadConfigRenderer?: () => Promise<string | undefined>;
}

export const resolveCliRendererMode = async (
  options: ResolveCliRendererModeOptions,
): Promise<ResolveRendererModeResult> => {
  const initial = resolveRendererMode({ argv: options.argv, env: options.env });
  if (initial.source === "flag" || initial.source === "env") return initial;
  const configValue = await (options.loadConfigRenderer ?? readConfigRendererValue)();
  if (configValue !== undefined && configValue !== "") {
    return resolveRendererMode({ argv: options.argv, env: options.env, configValue });
  }
  return initial;
};
