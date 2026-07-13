import {
  type CompiledCommand,
  type OclifArgDefinition,
  type OclifFlagDefinition,
  argDefinitionsForCommand,
  commandName,
  flagDefinitionsForCommand,
} from "./compiled-argv.ts";

export const helpFlagToken = (name: string, definition: OclifFlagDefinition): string => {
  const short = definition.char === undefined ? "" : `, -${definition.char}`;
  return `--${definition.name ?? name}${short}`;
};

export const helpArgToken = (name: string, definition: OclifArgDefinition, repeatable: boolean): string => {
  const label = `${name.toUpperCase()}${repeatable ? "..." : ""}`;
  return definition.required === true ? `<${label}>` : `[${label}]`;
};

export const renderCommandUsage = (id: string, command: CompiledCommand): string => {
  const definitions = Object.entries(argDefinitionsForCommand(command));
  const repeatable = command.strict === false && definitions.length === 1;
  const args = definitions.map(([name, definition]) => helpArgToken(name, definition, repeatable));
  const name = commandName(id, command);
  return args.length === 0 ? name : `${name} ${args.join(" ")}`;
};

export const renderCommandHelpFlags = (command: CompiledCommand): ReadonlyArray<string> => {
  const entries = Object.entries(flagDefinitionsForCommand(command)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return [];

  const lines = ["", "FLAGS"];
  for (const [name, definition] of entries) {
    const options = definition.options === undefined ? "" : ` (${definition.options.join(", ")})`;
    const description = definition.description === undefined ? "" : ` ${definition.description}${options}`;
    lines.push(`  ${helpFlagToken(name, definition)}${description}`);
  }
  return lines;
};
