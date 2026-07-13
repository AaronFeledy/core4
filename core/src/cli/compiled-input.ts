import type { RendererMode } from "./bug-report.ts";
import { normalizeScratchStartArgv } from "./commands/scratch.ts";
import {
  argDefinitionsForCommand,
  commandSpecForId,
  flagDefinitionsForCommand,
  flagNameByToken,
  hasUniversalFormatFlag,
  setParsedFlag,
} from "./compiled-argv.ts";
import { type CompiledCommandInput, activeRendererMode, activeResultFormat } from "./compiled-runtime.ts";
import { type ResultFormat, resolveResultFormat } from "./format-flags.ts";

export const compiledCommandInputFromArgv = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: {
    readonly rendererMode?: RendererMode;
    readonly resultFormat?: ResultFormat;
    readonly signal?: AbortSignal;
  } = {},
): CompiledCommandInput => {
  const formatResolution =
    options.resultFormat === undefined && hasUniversalFormatFlag(argv)
      ? resolveResultFormat({ argv, rendererMode: options.rendererMode ?? activeRendererMode })
      : undefined;
  const effectiveResultFormat = options.resultFormat ?? formatResolution?.format ?? activeResultFormat;
  const command = commandSpecForId(commandId);
  if (command === undefined) {
    const flags: Record<string, unknown> = {};
    flags.format = effectiveResultFormat;
    if (effectiveResultFormat === "json") flags.json = true;
    return { argv, flags, args: {}, ...options, resultFormat: effectiveResultFormat };
  }
  const argvWithoutUniversalFormat = formatResolution?.remainingArgv ?? argv;
  const normalizedArgv =
    commandId === "apps:scratch:start"
      ? normalizeScratchStartArgv(argvWithoutUniversalFormat)
      : argvWithoutUniversalFormat;
  const flagDefinitions = flagDefinitionsForCommand(command);
  const flagTokens = flagNameByToken(flagDefinitions);
  const argNames = Object.keys(argDefinitionsForCommand(command));
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

    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }

  const args: Record<string, unknown> = {};
  for (const [index, name] of argNames.entries()) {
    const value = positionals[index];
    if (value !== undefined) args[name] = value;
  }

  flags.format = effectiveResultFormat;
  if (effectiveResultFormat === "json") flags.json = true;

  return { argv: normalizedArgv, flags, args, ...options, resultFormat: effectiveResultFormat };
};
