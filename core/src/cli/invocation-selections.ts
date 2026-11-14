import {
  JsonJqConflictError,
  JsonProjectionError,
  LogLevelSelectionError,
  NotImplementedError,
  RendererSelectionError,
} from "@lando/sdk/errors";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { selectionOwnershipHint } from "./cli-help";
import {
  activeJq,
  activeJsonControl,
  activeRendererMode,
  activeResultFormat,
  setActiveCommandId,
  setActiveDeprecationWarnings,
  setActiveJq,
  setActiveJsonControl,
  setActiveRendererMode,
  setActiveResultFormat,
} from "./compiled-runtime";
import {
  DEFAULT_RESULT_FORMAT,
  extractFormatFlags,
  isEnvelopeResultFormat,
  resolveJsonControl,
  resolveResultFormat,
} from "./format-flags";
import { type LandoFlagMatch, failedLandoFlag, scanLandoFlags } from "./lando-flags";
import { resolveLogLevel } from "./log-level-selection";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "./renderer-boundary";
import { applyDebugRendererFlip, type readConfigCliGlobals } from "./renderer-mode-resolution";
import { setActiveLogLevel } from "./renderer-mode-state";
import { preCommandOutputMode, renderPreCommandFailure } from "./spec/command-boundary";
import { resolveTrace, setActiveTrace } from "./trace-selection";

/**
 * The selection chain: trace, log level, renderer, result format, and JSON
 * control, applied in typed order before any owner handler runs.
 */

const jsonControlConflict = (): JsonJqConflictError | JsonProjectionError | undefined => {
  if (activeJsonControl.mode === "list" && activeJq !== undefined) {
    return new JsonJqConflictError({
      message: "Cannot combine --jq with bare --json.",
      remediation: "cannot use --jq with bare --json; pass --json key1,key2 or omit --json",
    });
  }
  if (
    (activeJsonControl.mode === "keys" || activeJq !== undefined) &&
    !isEnvelopeResultFormat(activeResultFormat)
  ) {
    return new JsonProjectionError({
      message: "JSON projection requires an envelope format.",
      keys: activeJsonControl.mode === "keys" ? [...activeJsonControl.keys] : [],
      available: [],
      reason: "format_conflict",
      remediation: "Use --format=json or --format=yaml, or omit --format when projecting or using --jq.",
    });
  }
  return undefined;
};

export const rejectJsonControlConflicts = async (context: CliInvocationContext): Promise<boolean> => {
  const error = jsonControlConflict();
  if (error === undefined) return false;
  setActiveCommandId("cli:json-control");
  await renderPreCommandFailure({
    context,
    commandId: "cli:json-control",
    error,
    rendererMode: activeRendererMode,
    resultFormat: "json",
    usage: true,
  });
  return true;
};

const applyRendererSelections = async (
  argv: ReadonlyArray<string>,
  context: CliInvocationContext,
  configGlobals: Awaited<ReturnType<typeof readConfigCliGlobals>>,
  protocolStdout: boolean,
): Promise<ReadonlyArray<string>> => {
  const trace = resolveTrace({
    argv,
    env: context.env,
    ...(configGlobals.tracing === undefined ? {} : { config: configGlobals.tracing }),
  });
  setActiveTrace(trace);
  const logLevelResolution = resolveLogLevel({
    argv: trace.remainingArgv,
    env: context.env,
    ...(configGlobals.logLevel === undefined ? {} : { configValue: configGlobals.logLevel }),
  });
  setActiveLogLevel(logLevelResolution.level);
  const resolution = await resolveCliRendererMode({
    argv: logLevelResolution.remainingArgv,
    env: context.env,
    loadConfigRenderer: async () => configGlobals.renderer,
  });
  const mode = protocolStdout
    ? resolution.mode
    : applyDebugRendererFlip({ verbose: logLevelResolution.verbose, renderer: resolution });
  setActiveRendererMode(mode);
  return resolution.remainingArgv;
};

const applyFormatSelections = (
  argv: ReadonlyArray<string>,
  context: CliInvocationContext,
  commandAbsent: boolean,
): void => {
  const deprecationWarnings = resolveCliDeprecationWarnings({ argv, env: context.env });
  setActiveDeprecationWarnings(deprecationWarnings.enabled);
  const extracted = extractFormatFlags(deprecationWarnings.remainingArgv);
  const formatResolution = resolveResultFormat({
    argv: deprecationWarnings.remainingArgv,
    rendererMode: activeRendererMode,
  });
  setActiveResultFormat(formatResolution.format);
  // Bare --json lists command result keys; without a command, retain root text help.
  if (formatResolution.source === "json" && extracted.jsonList && commandAbsent) {
    setActiveResultFormat(DEFAULT_RESULT_FORMAT);
  }
  setActiveJsonControl(resolveJsonControl(extracted, formatResolution.format));
  setActiveJq(extracted.jq);
  if (
    extracted.jq !== undefined &&
    activeJsonControl.mode === "off" &&
    formatResolution.source !== "format"
  ) {
    setActiveResultFormat("json");
  }
};

/** Keep the tagged error and fields; only the remediation gains the ownership guidance. */
const extendSelectionError = (
  error: RendererSelectionError | LogLevelSelectionError | NotImplementedError,
  hint: string,
): RendererSelectionError | LogLevelSelectionError | NotImplementedError => {
  if (error instanceof RendererSelectionError)
    return new RendererSelectionError({
      message: error.message,
      value: error.value,
      source: error.source,
      remediation: `${error.remediation} ${hint}`,
    });
  if (error instanceof LogLevelSelectionError)
    return new LogLevelSelectionError({
      message: error.message,
      value: error.value,
      source: error.source,
      remediation: `${error.remediation} ${hint}`,
    });
  return new NotImplementedError({
    message: error.message,
    commandId: error.commandId,
    remediation: `${error.remediation} ${hint}`,
  });
};

export const applyInvocationSelections = async (
  globals: ReadonlyArray<string>,
  context: CliInvocationContext,
  configGlobals: Awaited<ReturnType<typeof readConfigCliGlobals>>,
  selection: {
    readonly protocolStdout: boolean;
    readonly commandAbsent: boolean;
    /** Present only for an enabled, non-wrapper tooling owner. */
    readonly ownership?: { readonly taskName: string };
  },
): Promise<boolean> => {
  let rendererSelected = false;
  try {
    const remaining = await applyRendererSelections(
      globals,
      context,
      configGlobals,
      selection.protocolStdout,
    );
    rendererSelected = true;
    applyFormatSelections(remaining, context, selection.commandAbsent);
  } catch (error) {
    if (
      !(
        error instanceof RendererSelectionError ||
        (!rendererSelected &&
          (error instanceof LogLevelSelectionError || error instanceof NotImplementedError))
      )
    )
      throw error;
    let commandId = "cli:format-selection";
    if (!rendererSelected) {
      commandId =
        error instanceof LogLevelSelectionError ? "cli:log-level-selection" : "cli:renderer-selection";
    }
    const match = failedLandoFlag(error);
    const rendered =
      selection.ownership !== undefined && match !== undefined
        ? extendSelectionError(error, selectionOwnershipHint(match, selection.ownership.taskName))
        : error;
    setActiveCommandId(commandId);
    await renderPreCommandFailure({
      context,
      commandId,
      error: rendered,
      ...preCommandOutputMode({ argv: globals, env: context.env }),
      usage: true,
    });
    return true;
  }
  return false;
};

/** The last `--format` occurrence in Lando's tokens: the one selection acted on. */
export const lastFormatFlag = (globals: ReadonlyArray<string>): LandoFlagMatch | undefined => {
  let last: LandoFlagMatch | undefined;
  scanLandoFlags(globals, {
    "--format": (match) => {
      last = match;
    },
  });
  return last;
};
