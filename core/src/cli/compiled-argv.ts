import type { Command } from "@oclif/core";

import type { LandoCommandSpec } from "./oclif/command-base.ts";
import compiledCommands from "./oclif/compiled-commands.ts";
import { loadCompiledManifest } from "./oclif/manifest.ts";

export type CompiledCommand = Command.Class;

export const commandEntries: Array<[string, CompiledCommand]> = Object.entries(compiledCommands).sort(
  ([left], [right]) => left.localeCompare(right),
);

export const compiledManifest = loadCompiledManifest();

export const commandName = (id: string, command: CompiledCommand): string => {
  const aliases = command.aliases;
  if (!aliases || aliases.length === 0) return id;
  const nonFlagAlias = aliases.find((alias) => !alias.startsWith("-"));
  if (nonFlagAlias !== undefined) return nonFlagAlias;
  return aliases[0] ?? id;
};

export const findCommand = (name: string): [string, CompiledCommand] | undefined =>
  commandEntries.find(([id, command]) => id === name || command.aliases?.includes(name));

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
  (compiledCommands as Readonly<Record<string, CompiledCommand>>)[commandId];

export const landoSpecForId = (commandId: string): LandoCommandSpec | undefined =>
  (commandSpecForId(commandId) as { readonly landoSpec?: LandoCommandSpec } | undefined)?.landoSpec;

export const flagDefinitionsForCommand = (
  command: CompiledCommand,
): Readonly<Record<string, OclifFlagDefinition>> => {
  const definitions = command as {
    readonly baseFlags?: Readonly<Record<string, OclifFlagDefinition>>;
    readonly flags?: Readonly<Record<string, OclifFlagDefinition>>;
  };
  return { ...(definitions.baseFlags ?? {}), ...(definitions.flags ?? {}) };
};

export const argDefinitionsForCommand = (
  command: CompiledCommand,
): Readonly<Record<string, OclifArgDefinition>> =>
  (command as { args?: Readonly<Record<string, OclifArgDefinition>> }).args ?? {};

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
    if (arg === "--format" || arg.startsWith("--format=") || arg === "--json" || arg === "-j") return true;
  }
  return false;
};
