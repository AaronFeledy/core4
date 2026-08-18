import type { RendererMode } from "./bug-report";
import { normalizeScratchStartArgv } from "./commands/scratch";
import {
  argDefinitionsForCommand,
  commandSpecForId,
  flagDefinitionsForCommand,
  flagNameByToken,
  hasUniversalFormatFlag,
  setParsedFlag,
} from "./compiled-argv";
import {
  type CompiledCommandInput,
  activeRendererMode,
  activeResultFormat,
  setActiveCommandInvocation,
} from "./compiled-runtime";
import { normalizeCliFlagTokens, validateCommandFlagValues } from "./flag-value-validation";
import { type ResultFormat, resolveResultFormat } from "./format-flags";

const withCommandRemainderSeparator = (
  argv: ReadonlyArray<string>,
  flagDefinitions: ReturnType<typeof flagDefinitionsForCommand>,
): ReadonlyArray<string> => {
  const flagTokens = flagNameByToken(flagDefinitions);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") return argv;
    const equalsIndex = arg.indexOf("=");
    const token = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const normalizedToken = normalizeCliFlagTokens([arg], flagDefinitions);
    const recognized = flagTokens.has(token) || normalizedToken.length !== 1 || normalizedToken[0] !== arg;
    if (!recognized) return [...argv.slice(0, index), "--", ...argv.slice(index)];

    const last = normalizedToken.at(-1);
    if (last === undefined || last.includes("=")) continue;
    const lastFlagName = flagTokens.get(last);
    if (lastFlagName !== undefined && flagDefinitions[lastFlagName]?.type !== "boolean") index += 1;
  }
  return argv;
};

export const compiledCommandInputFromArgv = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: {
    readonly rendererMode?: RendererMode;
    readonly resultFormat?: ResultFormat;
    readonly signal?: AbortSignal;
  } = {},
): CompiledCommandInput => {
  const command = commandSpecForId(commandId);
  const argDefinitions = command === undefined ? {} : argDefinitionsForCommand(command);
  const flagDefinitions = command === undefined ? {} : flagDefinitionsForCommand(command);
  const commandRemainderArgv =
    command?.strict === false && command.args?.command !== undefined
      ? withCommandRemainderSeparator(argv, flagDefinitions)
      : argv;
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
    const input = { argv, flags, args: {}, ...options, resultFormat: effectiveResultFormat };
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
  const flagTokens = flagNameByToken(flagDefinitions);
  const argNames = Object.keys(argDefinitions);
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...normalizedArgv.slice(index + 1));
      break;
    }

    const equalsIndex = arg.indexOf("=");
    const token = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const flagName = flagTokens.get(token);
    if (flagName !== undefined) {
      const definition = flagDefinitions[flagName] ?? {};
      if (definition.type === "boolean") {
        setParsedFlag(flags, flagName, true, definition);
        continue;
      }
      const value = equalsIndex === -1 ? normalizedArgv[index + 1] : arg.slice(equalsIndex + 1);
      if (value === undefined) continue;
      setParsedFlag(flags, flagName, value, definition);
      if (equalsIndex === -1) index += 1;
      continue;
    }

    if (command.strict === false || !arg.startsWith("-")) positionals.push(arg);
  }

  const args: Record<string, unknown> = {};
  for (const [index, name] of argNames.entries()) {
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
    resultFormat: effectiveResultFormat,
  };
  setActiveCommandInvocation(commandId, input);
  return input;
};
