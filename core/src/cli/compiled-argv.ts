import { builtInCommandEntries, resolveBuiltInCommand } from "./built-in-command-registry";
import { formatFlagDefsForCommand } from "./format-flags";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";
import { type LandoCommandSpec, resolveTopLevelAliases } from "./spec/command-base";

export type CompiledCommand = LandoCommandSpec;

export const commandEntries: ReadonlyArray<readonly [string, CompiledCommand]> = builtInCommandEntries.map(
  (entry) => [entry.spec.id, entry.spec],
);

export const commandRegistryManifest = COMMAND_REGISTRY_MANIFEST;

export const commandName = (id: string, command: CompiledCommand): string => {
  const aliases = resolveTopLevelAliases(command);
  if (aliases.length === 0) return id;
  const nonFlagAlias = aliases.find((alias) => !alias.startsWith("-"));
  if (nonFlagAlias !== undefined) return nonFlagAlias;
  return aliases[0] ?? id;
};

export const findCommand = (name: string): [string, CompiledCommand] | undefined => {
  const entry = resolveBuiltInCommand(name);
  return entry === undefined ? undefined : [entry.spec.id, entry.spec];
};

export type OclifFlagDefinition = {
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
  readonly valueType?: "string" | "integer";
  readonly char?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly multiple?: boolean;
  readonly options?: ReadonlyArray<string>;
};

export type OclifArgDefinition = {
  readonly required?: boolean;
};

export const commandSpecForId = (commandId: string): CompiledCommand | undefined =>
  builtInCommandEntries.find((entry) => entry.spec.id === commandId)?.spec;

/** Typeable invocation shape for command-structure misuse errors. */
export const commandStructureExample = (commandId: string): string | undefined => {
  const command = commandSpecForId(commandId);
  if (command === undefined) return undefined;
  const name = commandName(commandId, command);
  if (command.usage !== undefined && command.usage.length > 0) return `lando ${name} ${command.usage}`;
  const definitions = Object.entries(command.args ?? {});
  const repeatable = command.strict === false && definitions.length === 1;
  const args = definitions.map(([argName, definition]) => {
    const label = `${argName.toUpperCase()}${repeatable ? "..." : ""}`;
    return definition.required === true ? `<${label}>` : `[${label}]`;
  });
  return args.length === 0 ? `lando ${name}` : `lando ${name} ${args.join(" ")}`;
};

export const landoSpecForId = (commandId: string): LandoCommandSpec | undefined =>
  commandSpecForId(commandId);

export const flagDefinitionsForCommand = (
  command: CompiledCommand,
): Readonly<Record<string, OclifFlagDefinition>> => formatFlagDefsForCommand(command);

export const argDefinitionsForCommand = (
  command: CompiledCommand,
): Readonly<Record<string, OclifArgDefinition>> => command.args ?? {};

export const flagNameByToken = (
  flags: Readonly<Record<string, OclifFlagDefinition>>,
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const [name, definition] of Object.entries(flags)) {
    out.set(`--${name}`, name);
    for (const alias of definition.aliases ?? []) out.set(`--${alias}`, name);
    if (definition.char !== undefined) out.set(`-${definition.char}`, name);
  }
  return out;
};

export const parseFlagValue = (
  definition: OclifFlagDefinition,
  value: string | boolean,
): string | number | boolean | undefined => {
  if (definition.valueType === "integer" && typeof value === "string") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return value;
};

export const setParsedFlag = (
  flags: Record<string, unknown>,
  name: string,
  value: string | boolean,
  definition: OclifFlagDefinition,
): void => {
  const parsed = parseFlagValue(definition, value);
  // undefined means the value was unparseable (e.g. non-numeric --tail): leave the flag unset.
  if (parsed === undefined) return;
  if (definition.multiple === true) {
    const existing = flags[name];
    flags[name] = Array.isArray(existing) ? [...existing, parsed] : [parsed];
    return;
  }
  flags[name] = parsed;
};

export interface ParsedFlagsAndPositionals {
  readonly flags: Record<string, unknown>;
  readonly positionals: ReadonlyArray<string>;
}

/**
 * Split an already-normalized argv into recognized flags and positionals.
 *
 * - `--` ends flag parsing; every later token is a positional.
 * - `--flag=value` and `--flag value` both bind `value`; a boolean flag never consumes the next token.
 * - A recognized flag whose inline value is missing at the end of argv is dropped, not errored; the
 *   caller validates values beforehand with `validateCommandFlagValues`.
 * - Unrecognized `-x` tokens are kept as positionals only when `strict` is false.
 *
 * `storeValue` lets a caller coerce a non-boolean value differently from `setParsedFlag` (plugin-owned
 * commands parse non-integer `number` flags as floats); boolean flags always go through `setParsedFlag`.
 */
export const parseFlagsAndPositionals = (
  normalizedArgv: ReadonlyArray<string>,
  flagDefinitions: Readonly<Record<string, OclifFlagDefinition>>,
  options: {
    readonly strict: boolean;
    readonly storeValue?: (
      flags: Record<string, unknown>,
      name: string,
      value: string,
      definition: OclifFlagDefinition,
    ) => void;
  },
): ParsedFlagsAndPositionals => {
  const flagTokens = flagNameByToken(flagDefinitions);
  const storeValue = options.storeValue ?? setParsedFlag;
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
      storeValue(flags, flagName, value, definition);
      if (equalsIndex === -1) index += 1;
      continue;
    }

    if (!options.strict || !arg.startsWith("-")) positionals.push(arg);
  }

  return { flags, positionals };
};

/**
 * Read one string-valued flag at `argv[index]` for hand-rolled adapter scanners.
 * Accepts `--name=value`, `--name value`, `-c value`, and `-c=value`; returns how many tokens it used.
 */
export const parseStringFlag = (
  argv: ReadonlyArray<string>,
  index: number,
  longName: string,
  shortName?: string,
): { readonly value: string; readonly consumed: number } | undefined => {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  const longEq = `--${longName}=`;
  if (arg.startsWith(longEq)) return { value: arg.slice(longEq.length), consumed: 1 };
  if (arg === `--${longName}` || (shortName !== undefined && arg === `-${shortName}`)) {
    const next = argv[index + 1];
    if (next === undefined) return undefined;
    return { value: next, consumed: 2 };
  }
  if (shortName !== undefined) {
    const shortEq = `-${shortName}=`;
    if (arg.startsWith(shortEq)) return { value: arg.slice(shortEq.length), consumed: 1 };
  }
  return undefined;
};

export const hasUniversalFormatFlag = (argv: ReadonlyArray<string>): boolean => {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "-j") return true;
    if (arg === "--format" || arg.startsWith("--format=")) return true;
    if (arg === "--json" || arg.startsWith("--json=")) return true;
    if (arg === "--jq" || arg.startsWith("--jq=")) return true;
  }
  return false;
};
