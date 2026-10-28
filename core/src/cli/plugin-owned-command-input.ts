import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { type CommandHelpEntry, renderCommandHelp } from "./cli-help";
import { type OclifFlagDefinition, parseFlagsAndPositionals, setParsedFlag } from "./compiled-argv";
import { normalizeCliFlagTokens, validateCommandCliFlags } from "./flag-value-validation";
import { universalFormatFlagDefs } from "./format-flags";
import { yesFlag } from "./spec/confirmation-flag";
import type { ArgDefinitions } from "./spec/metadata";

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
  const args: ArgDefinitions = Object.fromEntries(
    Object.entries(spec.args ?? {}).map(([name, definition]) => [
      name,
      {
        type: "option",
        ...(definition.required === undefined ? {} : { required: definition.required }),
        ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
      },
    ]),
  );
  const entry: CommandHelpEntry = {
    spec: {
      id: spec.id,
      summary: spec.summary,
      args,
      flags: pluginFlagDefinitions(spec),
      ...(spec.strict === undefined ? {} : { strict: spec.strict }),
    },
    status: { kind: "implemented" },
  };
  return renderCommandHelp(entry);
};
