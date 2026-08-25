import type { Effect, Layer, Schema } from "effect";

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

import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import { cliRuntimeOptions, resolveEffectiveCliBootstrap } from "@lando/engine/runtime/cli-options";
import "../runtime/bundled-plugins";
import { makeLandoRuntime } from "../runtime/layer";

import type { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import type { RendererIO } from "@lando/renderer/io";
import { landoSpecForId } from "./compiled-argv";
import {
  type CompiledCommandInput,
  activeCommandId,
  activeDeprecationWarnings,
  activeResultFormat,
  commandErrorMessage,
  getActiveCommandInvocation,
} from "./compiled-session";
import { type RenderContext, runWithRendererHandling } from "./renderer-boundary";
import { activeRendererMode } from "./renderer-mode-state";
import { EmptyResultSchema } from "./spec/command-base";

type CompiledRuntimeFactory = (bootstrap: BootstrapLevel) => ReturnType<typeof makeLandoRuntime>;

const makeCompiledRuntime: CompiledRuntimeFactory = (bootstrap) =>
  makeLandoRuntime(cliRuntimeOptions({ bootstrap, plugins: { policy: "discovery" } }));

export { activeRendererMode, setActiveRendererMode } from "./renderer-mode-state";
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
} from "./compiled-session";
export {
  flagTokenOf,
  invocationParityError,
  rejectInvalidInvocation,
} from "./compiled-invocation-parity";

export const resolveCompiledCommandRuntime = <ROut, E, RIn>(
  commandId: string,
  declaredBootstrap: BootstrapLevel,
  runtime: Layer.Layer<ROut, E, RIn>,
  runtimeForBootstrap: CompiledRuntimeFactory = makeCompiledRuntime,
) => {
  const effectiveBootstrap = resolveEffectiveCliBootstrap(commandId, declaredBootstrap);
  return effectiveBootstrap === declaredBootstrap ? runtime : runtimeForBootstrap(effectiveBootstrap);
};

export const runCompiledCommand = <A, E, R, RE>(
  operation: Effect.Effect<A, E, R>,
  runtime: Layer.Layer<Exclude<R, EventService | Renderer | StreamFrameSink>, RE>,
  render: (value: A, ctx: RenderContext) => string | undefined,
  options: {
    readonly plainTaskEvents?: "detail-only";
    readonly deprecationWarnings?: boolean;
    readonly suppressDeprecationDiagnostics?: boolean;
    readonly successExitCode?: (value: A) => number | undefined;
    readonly failureExitCode?: (error: unknown) => number | undefined;
    readonly resultSchema?: Schema.Schema.AnyNoContext;
    readonly redactionTokens?: (value: A) => ReadonlyArray<string>;
    readonly streamingMode?: "live";
    readonly preCommand?: boolean;
    readonly io?: RendererIO;
    readonly runtimeForBootstrap?: CompiledRuntimeFactory;
  } = {},
): Promise<void> => {
  const spec = landoSpecForId(activeCommandId);
  const effectiveRuntime =
    spec?.bootstrap === undefined
      ? runtime
      : resolveCompiledCommandRuntime(activeCommandId, spec.bootstrap, runtime, options.runtimeForBootstrap);
  const redactionTokens = options.redactionTokens ?? spec?.redactionTokens;
  const successExitCode =
    options.successExitCode ??
    (spec?.successExitCode === undefined
      ? undefined
      : (value: A) => spec.successExitCode?.(value, getActiveCommandInvocation()));
  const invocation = getActiveCommandInvocation();
  const rendererOptions = {
    runtime: effectiveRuntime as Layer.Layer<
      Exclude<R, EventService | Renderer | StreamFrameSink>,
      RE | ConfigError | LandoRuntimeBootstrapError
    >,
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
  (process as NodeJS.EventEmitter).once("SIGINT", abort);
  (process as NodeJS.EventEmitter).once("SIGTERM", abort);
  try {
    await run(controller.signal);
  } finally {
    (process as NodeJS.EventEmitter).off("SIGINT", abort);
    (process as NodeJS.EventEmitter).off("SIGTERM", abort);
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
