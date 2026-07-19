import { type Effect, Layer, type Schema } from "effect";

import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type {
  AppPlanner,
  BuildOrchestrator,
  ConfigService,
  EventService,
  FileSystem,
  GlobalAppService,
  PluginRegistry,
  Renderer,
  RuntimeProviderRegistry,
  ScratchAppService,
} from "@lando/sdk/services";

import type { BootstrapLevel } from "../runtime/bootstrap.ts";
import { cliRuntimeOptions, resolveEffectiveCliBootstrap } from "../runtime/cli-options.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";

import { landoSpecForId } from "./compiled-argv.ts";
import {
  type CompiledCommandInput,
  activeCommandId,
  activeDeprecationWarnings,
  activeResultFormat,
  commandErrorMessage,
  getActiveCommandInvocation,
} from "./compiled-session.ts";
import { EmptyResultSchema } from "./oclif/command-base.ts";
import { type RenderContext, runWithRendererHandling } from "./renderer-boundary.ts";
import { activeRendererMode } from "./renderer-mode-state.ts";
import type { RendererIO } from "./renderer/io.ts";
import type { StreamFrameSink } from "./stream-frame-sink.ts";

export { activeRendererMode, setActiveRendererMode } from "./renderer-mode-state.ts";
export {
  type CompiledCommandInput,
  activeCommandId,
  activeDeprecationWarnings,
  activeResultFormat,
  beginNestedCommandInvocation,
  clearActiveCommandInvocation,
  commandErrorMessage,
  emitDiagnosticLine,
  emitResultLine,
  getActiveCommandInvocation,
  resetActiveCommandInvocation,
  setActiveCommandId,
  setActiveCommandInvocation,
  setActiveDeprecationWarnings,
  setActiveResultFormat,
} from "./compiled-session.ts";
export {
  flagTokenOf,
  invocationParityError,
  rejectInvalidInvocation,
} from "./compiled-invocation-parity.ts";

export const resolveCompiledCommandRuntime = <ROut, E, RIn>(
  commandId: string,
  declaredBootstrap: BootstrapLevel,
  runtime: Layer.Layer<ROut, E, RIn>,
) => {
  const effectiveBootstrap = resolveEffectiveCliBootstrap(commandId, declaredBootstrap);
  return effectiveBootstrap === declaredBootstrap
    ? runtime
    : Layer.merge(
        runtime,
        makeLandoRuntime(
          cliRuntimeOptions({
            bootstrap: effectiveBootstrap,
            plugins: { policy: "discovery" },
          }),
        ),
      );
};

export const runCompiledCommand = <A, E, R, RE>(
  operation: Effect.Effect<A, E, R>,
  runtime: Layer.Layer<Exclude<R, EventService | Renderer | StreamFrameSink>, RE>,
  render: (value: A, ctx: RenderContext) => string | undefined,
  options: {
    readonly renderEvents?: boolean;
    readonly plainTaskEvents?: "detail-only";
    readonly deprecationWarnings?: boolean;
    readonly suppressDeprecationDiagnostics?: boolean;
    readonly successExitCode?: (value: A) => number | undefined;
    readonly failureExitCode?: (error: unknown) => number | undefined;
    readonly resultSchema?: Schema.Schema.AnyNoContext;
    readonly streamingMode?: "live";
    readonly preCommand?: boolean;
    readonly io?: RendererIO;
  } = {},
): Promise<void> => {
  const spec = landoSpecForId(activeCommandId);
  const effectiveRuntime =
    spec?.bootstrap === undefined
      ? runtime
      : resolveCompiledCommandRuntime(activeCommandId, spec.bootstrap, runtime);
  const redactionTokens = spec?.redactionTokens;
  const successExitCode =
    options.successExitCode ??
    (spec?.successExitCode === undefined
      ? undefined
      : (value: A) => spec.successExitCode?.(value, getActiveCommandInvocation()));
  const invocation = getActiveCommandInvocation();
  const rendererOptions = {
    runtime: effectiveRuntime,
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    command: activeCommandId,
    ...(options.preCommand !== true && invocation !== undefined ? { invocation } : {}),
    resultSchema: options.resultSchema ?? spec?.resultSchema ?? EmptyResultSchema,
    ...(options.preCommand === true || spec?.streaming === undefined ? {} : { streaming: spec.streaming }),
    ...(options.preCommand === true || options.streamingMode === undefined
      ? {}
      : { streamingMode: options.streamingMode }),
    ...(options.preCommand === true || spec?.streamFrames === undefined
      ? {}
      : { streamFrames: spec.streamFrames }),
    ...(redactionTokens === undefined ? {} : { redactionTokens }),
    deprecationWarnings: activeDeprecationWarnings && options.deprecationWarnings !== false,
    suppressDeprecationDiagnostics: options.suppressDeprecationDiagnostics === true,
    ...(options.renderEvents === undefined ? {} : { renderEvents: options.renderEvents }),
    ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
    ...(successExitCode === undefined ? {} : { successExitCode }),
    ...(options.failureExitCode === undefined ? {} : { failureExitCode: options.failureExitCode }),
    ...(options.io === undefined ? {} : { io: options.io }),
    render,
    formatError: (error: unknown) => commandErrorMessage(error),
  };
  return runWithRendererHandling(operation, rendererOptions);
};

export const runWithProcessAbortSignal = async (
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await run(controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};

export const appRuntimeLayer = () =>
  makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }));

export const compiledFormat = (_input: CompiledCommandInput): "text" | "json" =>
  activeResultFormat === "json" ? "json" : "text";

export const activeTableJsonFormat = (): "json" | "table" =>
  activeResultFormat === "json" ? "json" : "table";

export const activeTextJsonFormat = (): "text" | "json" => (activeResultFormat === "json" ? "json" : "text");

export const activeTextJsonYamlFormat = (): "text" | "json" | "yaml" => {
  if (activeResultFormat === "json" || activeResultFormat === "yaml") return activeResultFormat;
  return "text";
};

export const globalRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "global", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<
    | GlobalAppService
    | PluginRegistry
    | RuntimeProviderRegistry
    | AppPlanner
    | BuildOrchestrator
    | FileSystem
    | EventService,
    ConfigError | LandoRuntimeBootstrapError
  >;

export const scratchRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "scratch", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<ScratchAppService, ConfigError | LandoRuntimeBootstrapError>;

export const scratchRunRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "scratch", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<
    ScratchAppService | ConfigService | FileSystem | RuntimeProviderRegistry,
    ConfigError | LandoRuntimeBootstrapError
  >;
