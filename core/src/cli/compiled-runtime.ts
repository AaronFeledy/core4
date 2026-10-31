import type { CompletedCommandResult } from "@lando/sdk/command-result";
import type { CommandCompletion } from "@lando/sdk/schema";
import type { Effect, Layer, Schema, Tracer } from "effect";

import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { EventService, Renderer } from "@lando/sdk/services";

import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import { cliRuntimeOptions, resolveEffectiveCliBootstrap } from "@lando/engine/runtime/cli-options";
import { defaultInterruptSignals } from "@lando/engine/runtime/process-signals";
import { makeLandoRuntime } from "../runtime/layer";

import type { RendererIO } from "@lando/renderer/io";
import { withCommandTracing } from "./command-tracing";
import { landoSpecForId } from "./compiled-argv";
import {
  activeCommandId,
  activeDeprecationWarnings,
  activeJq,
  activeProjectResultKeys,
  activeResultFormat,
  commandErrorMessage,
  getActiveCommandInvocation,
} from "./compiled-session";
import { type RenderContext, runWithRendererHandling } from "./renderer-boundary";
import { activeRendererMode } from "./renderer-mode-state";
import { EmptyResultSchema } from "./spec/command-base";
import { activeTrace } from "./trace-selection";

type CompiledRuntimeFactory = (bootstrap: BootstrapLevel) => ReturnType<typeof makeLandoRuntime>;

const makeCompiledRuntime: CompiledRuntimeFactory = (bootstrap) =>
  makeLandoRuntime(cliRuntimeOptions({ bootstrap, plugins: { policy: "discovery" } }));

export { activeRendererMode, setActiveRendererMode } from "./renderer-mode-state";
export {
  type CompiledCommandInput,
  type JsonControl,
  activeCommandId,
  activeDeprecationWarnings,
  activeJq,
  activeJsonControl,
  activeProjectResultKeys,
  activeResultFormat,
  beginNestedCommandInvocation,
  clearActiveCommandInvocation,
  commandErrorMessage,
  emitDiagnosticLine,
  emitJsonListModeIfRequested,
  emitResultLine,
  getActiveCommandInvocation,
  resetActiveCommandInvocation,
  setActiveCommandId,
  setActiveCommandInvocation,
  setActiveDeprecationWarnings,
  setActiveJq,
  setActiveJsonControl,
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
  const invocation = getActiveCommandInvocation();
  if (
    commandId === "meta:update" &&
    invocation?.commandId === commandId &&
    invocation.flags["dry-run"] === true
  ) {
    return makeLandoRuntime(
      cliRuntimeOptions({
        bootstrap: "plugins",
        plugins: { policy: "bundled-only" },
        telemetry: false,
      }),
    );
  }
  const effectiveBootstrap = resolveEffectiveCliBootstrap(commandId, declaredBootstrap);
  return effectiveBootstrap === declaredBootstrap ? runtime : runtimeForBootstrap(effectiveBootstrap);
};

export const runCompiledCommand = <A, E, R, RE>(
  operation: Effect.Effect<A, E, R>,
  runtime: Layer.Layer<Exclude<R, EventService | Renderer>, RE>,
  render: (value: A, ctx: RenderContext) => string | undefined,
  options: {
    readonly deprecationWarnings?: boolean;
    readonly suppressDeprecationDiagnostics?: boolean;
    readonly completion?: (value: A) => CommandCompletion;
    readonly renderEffect?: (completed: CompletedCommandResult<A>) => Effect.Effect<void, unknown, R>;
    readonly failureExitCode?: (error: unknown) => number | undefined;
    readonly resultSchema?: Schema.Codec<unknown, unknown>;
    readonly redactionTokens?: (value: A) => ReadonlyArray<string>;
    readonly streamingMode?: "live";
    readonly preCommand?: boolean;
    readonly io?: RendererIO;
    readonly runtimeForBootstrap?: CompiledRuntimeFactory;
    readonly tracer?: Tracer.Tracer;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> => {
  const spec = landoSpecForId(activeCommandId);
  const effectiveRuntime =
    spec?.bootstrap === undefined ||
    activeCommandId === "meta:config" ||
    activeCommandId === "meta:doctor" ||
    activeCommandId === "meta:uninstall"
      ? runtime
      : resolveCompiledCommandRuntime(activeCommandId, spec.bootstrap, runtime, options.runtimeForBootstrap);
  const redactionTokens = options.redactionTokens ?? spec?.redactionTokens;
  const specCompletion = spec?.completion;
  const completion =
    options.completion ??
    (specCompletion === undefined
      ? undefined
      : (value: A) => specCompletion(value, getActiveCommandInvocation()));
  const invocation = getActiveCommandInvocation();
  const projectResultKeys = activeProjectResultKeys();
  const jqExpression = activeJq;
  // A command-owned document survives only on a plain success: --jq and
  // --json=<keys> select inside the envelope, so they take the envelope path.
  const documentOutput =
    spec?.documentOutput?.format === activeResultFormat &&
    (spec.documentOutput.when?.(invocation) ?? true) &&
    projectResultKeys === undefined &&
    jqExpression === undefined;
  const rendererOptions = {
    runtime: effectiveRuntime as Layer.Layer<
      Exclude<R, EventService | Renderer>,
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
    ...(projectResultKeys === undefined ? {} : { projectResultKeys }),
    ...(jqExpression === undefined ? {} : { jqExpression }),
    ...(documentOutput ? { documentOutput: true } : {}),
    deprecationWarnings: activeDeprecationWarnings && options.deprecationWarnings !== false,
    suppressDeprecationDiagnostics: options.suppressDeprecationDiagnostics === true,
    ...(completion === undefined ? {} : { completion }),
    ...(options.renderEffect === undefined ? {} : { renderEffect: options.renderEffect }),
    ...(options.failureExitCode === undefined ? {} : { failureExitCode: options.failureExitCode }),
    ...(options.io === undefined ? {} : { io: options.io }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    render,
    formatError: (
      failure: import("@lando/sdk/command-result").ProjectedFailure,
      redactor: import("@lando/sdk/secrets").Redactor,
    ) => commandErrorMessage(failure, activeCommandId, redactor),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  };
  const selection = activeTrace();
  if (options.tracer === undefined && selection?.enabled === true) {
    return withCommandTracing(
      selection,
      (capture, redactionTokens) =>
        runWithRendererHandling(operation, {
          ...rendererOptions,
          tracer: capture.tracer,
          traceCapture: capture,
          traceDisplay: selection.display,
          sourceEnv: selection.env,
          extraRedactionTokens: redactionTokens,
        }),
      invocation?.flags,
    );
  }
  return runWithRendererHandling(operation, rendererOptions);
};

export const runWithProcessAbortSignal = async (
  run: (signal: AbortSignal) => Promise<void>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> => {
  if (options.signal !== undefined) {
    if (!options.signal.aborted) await run(options.signal);
    return;
  }
  const controller = new AbortController();
  const handlers = defaultInterruptSignals().map((signal) => {
    const abort = () => controller.abort(signal);
    (process as NodeJS.EventEmitter).on(signal, abort);
    return { signal, abort };
  });
  try {
    await run(controller.signal);
  } finally {
    for (const { signal, abort } of handlers) (process as NodeJS.EventEmitter).off(signal, abort);
  }
};
