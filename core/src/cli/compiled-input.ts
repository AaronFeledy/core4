import type { CliInvocationContext } from "../runtime/invocation-context";
import type { RendererMode } from "./bug-report";
import { normalizeScratchStartArgv } from "./commands/scratch";
import {
  argDefinitionsForCommand,
  commandSpecForId,
  flagDefinitionsForCommand,
  parseFlagsAndPositionals,
} from "./compiled-argv";
import {
  type CompiledCommandInput,
  activeRendererMode,
  activeResultFormat,
  setActiveCommandInvocation,
} from "./compiled-runtime";
import { nonePolicy, specOwnerPolicy } from "./flag-claims";
import { normalizeCliFlagTokens } from "./flag-tokens";
import { validateCommandFlagValues } from "./flag-value-validation";
import { type ResultFormat, resolveResultFormat } from "./format-flags";
import { type CommandTokens, splitCommandTokens } from "./invocation";

export const compiledCommandInputFromArgv = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: {
    /** The dispatcher's already split tokens; omitted by callers without one. */
    readonly tokens?: CommandTokens;
    readonly rendererMode?: RendererMode;
    readonly resultFormat?: ResultFormat;
    readonly signal?: AbortSignal;
    readonly context?: CliInvocationContext;
  } = {},
): CompiledCommandInput => {
  const { tokens: suppliedTokens, ...inputOptions } = options;
  const command = commandSpecForId(commandId);
  const flagDefinitions = command === undefined ? {} : flagDefinitionsForCommand(command);
  const policy = command === undefined ? nonePolicy(true) : specOwnerPolicy(command, flagDefinitions);
  let tokens: CommandTokens;
  let standaloneGlobals: ReadonlyArray<string> | undefined;
  if (suppliedTokens === undefined) {
    const split = splitCommandTokens(argv, policy, "output");
    tokens = split.command;
    standaloneGlobals = split.globals;
  } else {
    tokens = suppliedTokens;
  }

  if (policy.tail === "all") {
    // A passthrough command owns every token after its name: no result-format
    // extraction, no short-option normalization, no flag parsing of the tail.
    const effectiveResultFormat = inputOptions.resultFormat ?? activeResultFormat;
    const flags: Record<string, unknown> = { format: effectiveResultFormat };
    if (effectiveResultFormat === "json") flags.json = true;
    const input = {
      argv,
      parsedArgv: argv,
      flags,
      args: {},
      ...inputOptions,
      rendererMode: inputOptions.rendererMode ?? activeRendererMode,
      resultFormat: effectiveResultFormat,
      hostIo: "cli" as const,
    };
    setActiveCommandInvocation(commandId, input);
    return input;
  }

  // A caller with a dispatcher passes its split and the already resolved
  // format; a standalone caller honors exactly the output flags it extracted.
  const formatResolution =
    standaloneGlobals !== undefined && standaloneGlobals.length > 0
      ? resolveResultFormat({
          argv: standaloneGlobals,
          rendererMode: inputOptions.rendererMode ?? activeRendererMode,
        })
      : undefined;
  const effectiveResultFormat = inputOptions.resultFormat ?? formatResolution?.format ?? activeResultFormat;

  if (command === undefined) {
    const flags: Record<string, unknown> = {};
    flags.format = effectiveResultFormat;
    if (effectiveResultFormat === "json") flags.json = true;
    const input = {
      argv,
      flags,
      args: {},
      ...inputOptions,
      rendererMode: inputOptions.rendererMode ?? activeRendererMode,
      resultFormat: effectiveResultFormat,
      hostIo: "cli" as const,
    };
    setActiveCommandInvocation(commandId, input);
    return input;
  }

  const lead = tokens.argv.slice(0, tokens.tailStart);
  const tail = tokens.argv.slice(tokens.tailStart);
  const commandLead = commandId === "apps:scratch:start" ? normalizeScratchStartArgv(lead) : lead;
  const normalizedLead = normalizeCliFlagTokens(commandLead, flagDefinitions);
  const flagValueError = validateCommandFlagValues(commandId, normalizedLead, flagDefinitions);
  if (flagValueError !== undefined) throw flagValueError;
  const argDefinitions = argDefinitionsForCommand(command);
  const argNames = Object.keys(argDefinitions);
  const { flags, positionals: leadPositionals } = parseFlagsAndPositionals(normalizedLead, flagDefinitions, {
    strict: command.strict !== false,
  });
  const tailPositionals = tail[0] === "--" ? tail.slice(1) : tail;
  const positionals = [...leadPositionals, ...tailPositionals];

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
    argv: [...normalizedLead, ...tail],
    ...(command.strict === false ? { parsedArgv: positionals } : {}),
    ...(policy.tail === "command" && tail[0] === "--" ? { separatorAt: leadPositionals.length } : {}),
    flags,
    args,
    ...inputOptions,
    rendererMode: inputOptions.rendererMode ?? activeRendererMode,
    resultFormat: effectiveResultFormat,
    hostIo: "cli" as const,
  };
  setActiveCommandInvocation(commandId, input);
  return input;
};
