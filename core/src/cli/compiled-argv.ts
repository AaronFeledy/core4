import { builtInCommandEntries, resolveBuiltInCommand } from "./built-in-command-registry";
import { universalFormatFlagDefs } from "./format-flags";
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

export const landoSpecForId = (commandId: string): LandoCommandSpec | undefined =>
  commandSpecForId(commandId);

export const flagDefinitionsForCommand = (
  command: CompiledCommand,
): Readonly<Record<string, OclifFlagDefinition>> => ({
  ...universalFormatFlagDefs,
  ...(command.flags ?? {}),
});

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
  name: string,
  value: string | boolean,
): string | number | boolean | undefined => {
  if (name === "tail" && typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return value;
};

export const setParsedFlag = (
  flags: Record<string, unknown>,
  name: string,
  value: string | boolean,
  definition: OclifFlagDefinition,
): void => {
  const parsed = parseFlagValue(name, value);
  // undefined means the value was unparseable (e.g. non-numeric --tail): leave the flag unset.
  if (parsed === undefined) return;
  if (definition.multiple === true) {
    const existing = flags[name];
    flags[name] = Array.isArray(existing) ? [...existing, parsed] : [parsed];
    return;
  }
  flags[name] = parsed;
};

export const hasUniversalFormatFlag = (argv: ReadonlyArray<string>): boolean => {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (
      arg === "--format" ||
      arg.startsWith("--format=") ||
      arg === "--json" ||
      arg.startsWith("--json=") ||
      arg === "-j" ||
      arg === "--jq" ||
      arg.startsWith("--jq=")
    ) {
      return true;
    }
  }
  return false;
};
