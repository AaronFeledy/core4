import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { helpArgToken, helpFlagToken } from "./cli-help";
import { type OclifFlagDefinition, parseFlagsAndPositionals, setParsedFlag } from "./compiled-argv";
import { normalizeCliFlagTokens, validateCommandCliFlags } from "./flag-value-validation";
import { universalFormatFlagDefs } from "./format-flags";
import { yesFlag } from "./spec/confirmation-flag";

export const pluginFlagDefinitions = (
  spec: Pick<ExecutableCommandSpec, "flags">,
): Readonly<Record<string, OclifFlagDefinition>> => {
  const flags: Record<string, OclifFlagDefinition> = { ...universalFormatFlagDefs };
  for (const [name, definition] of Object.entries(spec.flags ?? {})) {
    if (name === "yes") {
      flags[name] = yesFlag(definition.description);
      continue;
    }
    flags[name] = {
      name,
      type: definition.type === "boolean" ? "boolean" : "option",
      ...(definition.valueType === undefined ? {} : { valueType: definition.valueType }),
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
      ...(definition.options === undefined ? {} : { options: definition.options }),
    };
  }
  return flags;
};

export const pluginOwnedCliFlagError = (
  spec: Pick<ExecutableCommandSpec, "id" | "flags" | "strict">,
  argv: ReadonlyArray<string>,
) =>
  validateCommandCliFlags({
    commandId: spec.id,
    argv,
    definitions: pluginFlagDefinitions(spec),
    allowUnknownFlags: spec.strict === false,
  });

export const pluginOwnedCommandInputFromArgv = (
  spec: Pick<ExecutableCommandSpec, "flags" | "args" | "strict">,
  argv: ReadonlyArray<string>,
): {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly raw: ReadonlyArray<string>;
} => {
  const flagDefinitions = pluginFlagDefinitions(spec);
  const normalizedArgv = normalizeCliFlagTokens(argv, flagDefinitions);
  const { flags, positionals } = parseFlagsAndPositionals(normalizedArgv, flagDefinitions, {
    strict: spec.strict !== false,
    storeValue: (target, flagName, value, definition) => {
      const specFlag = spec.flags?.[flagName];
      if (specFlag?.type === "number" && specFlag.valueType !== "integer") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) target[flagName] = parsed;
        return;
      }
      setParsedFlag(target, flagName, value, definition);
    },
  });
  const argNames = Object.keys(spec.args ?? {});
  const args: Record<string, unknown> = {};
  const raw: string[] = [];
  for (const [index, value] of positionals.entries()) {
    const name = argNames[index];
    if (name === undefined) raw.push(value);
    else args[name] = value;
  }
  return { flags, args, raw };
};

export const renderPluginOwnedCommandHelp = (spec: ExecutableCommandSpec): string => {
  const argEntries = Object.entries(spec.args ?? {});
  const repeatable = spec.strict === false && argEntries.length === 1;
  const usageArgs = argEntries.map(([name, definition]) =>
    helpArgToken(
      name,
      definition.required === undefined ? {} : { required: definition.required },
      repeatable,
    ),
  );
  const usage = usageArgs.length === 0 ? spec.id : `${spec.id} ${usageArgs.join(" ")}`;
  const flagEntries = Object.entries(pluginFlagDefinitions(spec)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const lines = [spec.summary, "", "USAGE", `  $ lando ${usage}`];
  if (flagEntries.length > 0) {
    lines.push("", "FLAGS");
    for (const [name, definition] of flagEntries) lines.push(`  ${helpFlagToken(name, definition)}`);
  }
  return lines.join("\n");
};
