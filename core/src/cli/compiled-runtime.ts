import { Effect, type Layer } from "effect";

import type { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
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

import { cliRuntimeOptions } from "../runtime/cli-options.ts";
import { makeLandoRuntime } from "../runtime/layer.ts";

import { type BugReportContext, type RendererMode, formatBugReport } from "./bug-report.ts";
import type { CliInvocationSnapshot } from "./command-lifecycle.ts";
import {
  argDefinitionsForCommand,
  commandSpecForId,
  flagDefinitionsForCommand,
  flagNameByToken,
  landoSpecForId,
} from "./compiled-argv.ts";
import { DEFAULT_RESULT_FORMAT, type ResultFormat } from "./format-flags.ts";
import { EmptyResultSchema } from "./oclif/command-base.ts";
import {
  type RenderContext,
  makeRendererServiceLiveForMode,
  runWithRendererHandling,
  writeDiagnosticLine,
  writeResultLine,
} from "./renderer-boundary.ts";
import type { StreamFrameSink } from "./stream-frame-sink.ts";

export interface CompiledCommandInput {
  readonly argv: ReadonlyArray<string>;
  readonly flags: Record<string, unknown>;
  readonly args: Record<string, unknown>;
  readonly rendererMode?: RendererMode;
  readonly resultFormat?: ResultFormat;
  readonly signal?: AbortSignal;
}

export let activeRendererMode: RendererMode = "lando";
export let activeResultFormat: ResultFormat = DEFAULT_RESULT_FORMAT;
export let activeDeprecationWarnings = true;
export let activeCommandId = "cli:unknown";
let activeCommandInvocation: CliInvocationSnapshot | undefined;

export const getActiveCommandInvocation = (): CliInvocationSnapshot | undefined => activeCommandInvocation;

export const setActiveRendererMode = (mode: RendererMode): void => {
  activeRendererMode = mode;
};

export const setActiveResultFormat = (format: ResultFormat): void => {
  activeResultFormat = format;
};

export const setActiveDeprecationWarnings = (enabled: boolean): void => {
  activeDeprecationWarnings = enabled;
};

export const setActiveCommandId = (commandId: string): void => {
  activeCommandId = commandId;
};

export const setActiveCommandInvocation = (
  commandId: string,
  input: Pick<CompiledCommandInput, "argv" | "args" | "flags">,
): void => {
  activeCommandInvocation = {
    commandId,
    argv: input.argv,
    args: input.args,
    flags: input.flags,
    cwd: process.cwd(),
  };
};

export const resetActiveCommandInvocation = (commandId: string, argv: ReadonlyArray<string>): void => {
  activeCommandInvocation = { commandId, argv, args: {}, flags: {}, cwd: process.cwd() };
};

export const commandErrorMessage = (error: unknown, commandId: string = activeCommandId): string => {
  const context: BugReportContext = { commandId };
  return formatBugReport({ error, context, rendererMode: activeRendererMode });
};

export const emitResultLine = (text: string): void => {
  Effect.runSync(
    writeResultLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
};

export const emitDiagnosticLine = (text: string): void => {
  Effect.runSync(
    writeDiagnosticLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
};

/**
 * Validate compiled-dispatch argv against a command's flag/arg definitions before
 * command execution. Returns the OCLIF-equivalent diagnostic, or `undefined` when valid.
 * Mirrors the consumption rules in `compiledCommandInputFromArgv`: a value flag
 * consumes the following token (even a `-`-prefixed one) as its value, and `--`
 * terminates flag parsing so everything after it is positional.
 */
export const flagTokenOf = (arg: string): string => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

export const invocationParityError = (commandId: string, argv: ReadonlyArray<string>): string | undefined => {
  const command = commandSpecForId(commandId);
  if (command === undefined) return undefined;
  const flagDefinitions = flagDefinitionsForCommand(command);
  const flagTokens = flagNameByToken(flagDefinitions);
  const maxPositionals = Object.keys(argDefinitionsForCommand(command)).length;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      for (let rest = index + 1; rest < argv.length; rest += 1) {
        const value = argv[rest];
        if (value !== undefined) positionals.push(value);
      }
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const token = flagTokenOf(arg);
    const flagName = flagTokens.get(token);
    if (flagName === undefined) return `Nonexistent flag: ${token}`;
    const definition = flagDefinitions[flagName] ?? {};
    if (definition.type === "boolean") {
      if (equalsIndex !== -1) return `Unexpected argument: ${arg.slice(equalsIndex + 1)}`;
      continue;
    }
    if (equalsIndex !== -1) {
      const value = arg.slice(equalsIndex + 1);
      if (definition.options !== undefined && !definition.options.includes(value)) {
        return `Expected ${token}=${value} to be one of: ${definition.options.join(", ")}`;
      }
      continue;
    }
    const next = argv[index + 1];
    const nextIsFlag = next !== undefined && next !== "-" && flagTokens.has(flagTokenOf(next));
    if (next === undefined || nextIsFlag) {
      return definition.options === undefined
        ? `Flag ${token} expects a value`
        : `Flag ${token} expects one of these values: ${definition.options.join(", ")}`;
    }
    if (definition.options !== undefined && !definition.options.includes(next)) {
      return `Expected ${token}=${next} to be one of: ${definition.options.join(", ")}`;
    }
    index += 1;
  }
  const extra = positionals[maxPositionals];
  if (extra !== undefined) return `Unexpected argument: ${extra}`;
  return undefined;
};

export const rejectInvalidInvocation = (commandId: string, argv: ReadonlyArray<string>): boolean => {
  const diagnostic = invocationParityError(commandId, argv);
  if (diagnostic === undefined) return false;
  emitDiagnosticLine(diagnostic);
  process.exitCode = 2;
  return true;
};

export const runCompiledCommand = <A, E, R, RE>(
  operation: Effect.Effect<A, E, R>,
  runtime: Layer.Layer<Exclude<R, Renderer | StreamFrameSink>, RE>,
  render: (value: A, ctx: RenderContext) => string | undefined,
  options: {
    readonly renderEvents?: boolean;
    readonly plainTaskEvents?: "detail-only";
    readonly deprecationWarnings?: boolean;
    readonly suppressDeprecationDiagnostics?: boolean;
    readonly successExitCode?: (value: A) => number | undefined;
    readonly streamingMode?: "live";
  } = {},
): Promise<void> => {
  const spec = landoSpecForId(activeCommandId);
  const redactionTokens = spec?.redactionTokens;
  const successExitCode =
    options.successExitCode ??
    (spec?.successExitCode === undefined
      ? undefined
      : (value: A) => spec.successExitCode?.(value, activeCommandInvocation));
  const rendererOptions = {
    runtime,
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
    command: activeCommandId,
    ...(activeCommandInvocation === undefined ? {} : { invocation: activeCommandInvocation }),
    resultSchema: spec?.resultSchema ?? EmptyResultSchema,
    ...(spec?.streaming === undefined ? {} : { streaming: spec.streaming }),
    ...(options.streamingMode === undefined ? {} : { streamingMode: options.streamingMode }),
    ...(spec?.streamFrames === undefined ? {} : { streamFrames: spec.streamFrames }),
    ...(redactionTokens === undefined ? {} : { redactionTokens }),
    deprecationWarnings: activeDeprecationWarnings && options.deprecationWarnings !== false,
    suppressDeprecationDiagnostics: options.suppressDeprecationDiagnostics === true,
    ...(options.renderEvents === undefined ? {} : { renderEvents: options.renderEvents }),
    ...(options.plainTaskEvents === undefined ? {} : { plainTaskEvents: options.plainTaskEvents }),
    ...(successExitCode === undefined ? {} : { successExitCode }),
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
    LandoRuntimeBootstrapError
  >;

export const scratchRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "scratch", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<ScratchAppService, LandoRuntimeBootstrapError>;

export const scratchRunRuntimeLayer = () =>
  makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: "scratch", plugins: { policy: "discovery" } }),
  ) as Layer.Layer<
    ScratchAppService | ConfigService | FileSystem | RuntimeProviderRegistry,
    LandoRuntimeBootstrapError
  >;
