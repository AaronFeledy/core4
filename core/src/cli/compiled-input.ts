import type { CliInvocationContext } from "../runtime/invocation-context";
import type { RendererMode } from "./bug-report";
import { withCommandRemainderSeparator } from "./command-tail";
import { normalizeScratchStartArgv } from "./commands/scratch";
import {
  argDefinitionsForCommand,
  builtInTailPolicy,
  commandSpecForId,
  flagDefinitionsForCommand,
  hasUniversalFormatFlag,
  parseFlagsAndPositionals,
} from "./compiled-argv";
import {
  type CompiledCommandInput,
  activeRendererMode,
  activeResultFormat,
  setActiveCommandInvocation,
} from "./compiled-runtime";
import { normalizeCliFlagTokens } from "./flag-tokens";
import { validateCommandFlagValues } from "./flag-value-validation";
import { type ResultFormat, resolveResultFormat } from "./format-flags";

export const compiledCommandInputFromArgv = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: {
    readonly rendererMode?: RendererMode;
    readonly resultFormat?: ResultFormat;
    readonly signal?: AbortSignal;
    readonly context?: CliInvocationContext;
  } = {},
): CompiledCommandInput => {
  const command = commandSpecForId(commandId);
  const tailPolicy = builtInTailPolicy(command);
  if (tailPolicy.kind === "all") {
    // A passthrough command owns every token after its name: no universal-format
    // extraction, no short-option normalization, no flag parsing of the tail.
    const effectiveResultFormat = options.resultFormat ?? activeResultFormat;
    const flags: Record<string, unknown> = { format: effectiveResultFormat };
    if (effectiveResultFormat === "json") flags.json = true;
    const input = {
      argv,
      parsedArgv: argv,
      flags,
      args: {},
      ...options,
      rendererMode: options.rendererMode ?? activeRendererMode,
      resultFormat: effectiveResultFormat,
      hostIo: "cli" as const,
    };
    setActiveCommandInvocation(commandId, input);
    return input;
  }
  const argDefinitions = command === undefined ? {} : argDefinitionsForCommand(command);
  const flagDefinitions = command === undefined ? {} : flagDefinitionsForCommand(command);
  const commandRemainderArgv =
    tailPolicy.kind === "command" ? withCommandRemainderSeparator(argv, flagDefinitions) : argv;
  const hasImplicitCommandSeparator = commandRemainderArgv !== argv;
  const formatResolution =
    options.resultFormat === undefined && hasUniversalFormatFlag(commandRemainderArgv)
      ? resolveResultFormat({
          argv: commandRemainderArgv,
          rendererMode: options.rendererMode ?? activeRendererMode,
        })
      : undefined;
  const effectiveResultFormat = options.resultFormat ?? formatResolution?.format ?? activeResultFormat;
  if (command === undefined) {
    const flags: Record<string, unknown> = {};
    flags.format = effectiveResultFormat;
    if (effectiveResultFormat === "json") flags.json = true;
    const input = {
      argv,
      flags,
      args: {},
      ...options,
      rendererMode: options.rendererMode ?? activeRendererMode,
      resultFormat: effectiveResultFormat,
      hostIo: "cli" as const,
    };
    setActiveCommandInvocation(commandId, input);
    return input;
  }
  const argvWithoutUniversalFormat = formatResolution?.remainingArgv ?? commandRemainderArgv;
  const commandArgv =
    commandId === "apps:scratch:start"
      ? normalizeScratchStartArgv(argvWithoutUniversalFormat)
      : argvWithoutUniversalFormat;
  const normalizedArgv = normalizeCliFlagTokens(commandArgv, flagDefinitions);
  const implicitSeparatorIndex = hasImplicitCommandSeparator ? normalizedArgv.indexOf("--") : -1;
  const flagValueError = validateCommandFlagValues(commandId, normalizedArgv, flagDefinitions);
  if (flagValueError !== undefined) throw flagValueError;
  const argNames = Object.keys(argDefinitions);
  const { flags, positionals } = parseFlagsAndPositionals(normalizedArgv, flagDefinitions, {
    strict: command.strict !== false,
  });

  const args: Record<string, unknown> = {};
  for (const [index, name] of argNames.entries()) {
    if (argDefinitions[name]?.multiple === true) {
      args[name] = positionals.slice(index);
      break;
    }
    const value = positionals[index];
    if (value !== undefined) args[name] = value;
  }

  flags.format = effectiveResultFormat;
  if (effectiveResultFormat === "json") flags.json = true;

  const input = {
    argv:
      implicitSeparatorIndex === -1
        ? normalizedArgv
        : [
            ...normalizedArgv.slice(0, implicitSeparatorIndex),
            ...normalizedArgv.slice(implicitSeparatorIndex + 1),
          ],
    ...(command.strict === false ? { parsedArgv: positionals } : {}),
    flags,
    args,
    ...options,
    rendererMode: options.rendererMode ?? activeRendererMode,
    resultFormat: effectiveResultFormat,
    hostIo: "cli" as const,
  };
  setActiveCommandInvocation(commandId, input);
  return input;
};
