import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import {
  type CommandHelpEntry,
  type CommandHelpOptions,
  type CommandHelpSpec,
  renderCommandHelp,
} from "./cli-help";
import { parseFlagsAndPositionals, setParsedFlag } from "./compiled-argv";
import { specTailKind } from "./flag-claims";
import { normalizeCliFlagTokens } from "./flag-tokens";
import { validateCommandCliFlags } from "./flag-value-validation";
import type { CommandTokens } from "./invocation";
import { pluginFlagDefinitions } from "./plugin-flag-definitions";

/** The lead only: everything before the plugin command's verbatim tail or first `--`. */
const pluginLead = (tokens: CommandTokens): ReadonlyArray<string> => tokens.argv.slice(0, tokens.tailStart);

export const pluginOwnedCliFlagError = (
  spec: Pick<ExecutableCommandSpec, "id" | "flags" | "strict" | "args">,
  tokens: CommandTokens,
) =>
  validateCommandCliFlags({
    commandId: spec.id,
    argv: pluginLead(tokens),
    definitions: pluginFlagDefinitions(spec),
    allowUnknownFlags: spec.strict === false,
    ...(specTailKind(spec) === "command" ? { commandTail: { commandName: spec.id } } : {}),
  });

export const pluginOwnedCommandInputFromArgv = (
  spec: Pick<ExecutableCommandSpec, "flags" | "args" | "strict">,
  tokens: CommandTokens,
): {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly raw: ReadonlyArray<string>;
} => {
  const flagDefinitions = pluginFlagDefinitions(spec);
  const normalizedLead = normalizeCliFlagTokens(pluginLead(tokens), flagDefinitions);
  const { flags, positionals: leadPositionals } = parseFlagsAndPositionals(normalizedLead, flagDefinitions, {
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
  const tail = tokens.argv.slice(tokens.tailStart);
  const positionals = [...leadPositionals, ...(tail[0] === "--" ? tail.slice(1) : tail)];
  const argNames = Object.keys(spec.args ?? {});
  const args: Record<string, unknown> = {};
  const raw: string[] = [];
  for (const [index, value] of positionals.entries()) {
    const name = argNames[index];
    if (name === undefined) raw.push(value);
    else if (spec.args?.[name]?.multiple === true) {
      args[name] = positionals.slice(index);
      break;
    } else args[name] = value;
  }
  return { flags, args, raw };
};

export const renderPluginOwnedCommandHelp = (
  spec: ExecutableCommandSpec,
  options?: Pick<CommandHelpOptions, "styled"> & { readonly aliases?: readonly string[] },
): string => {
  const args: CommandHelpSpec["args"] = Object.fromEntries(
    Object.entries(spec.args ?? {}).map(([name, definition]) => [
      name,
      {
        type: "option",
        ...(definition.description === undefined ? {} : { description: definition.description }),
        ...(definition.stdio === undefined ? {} : { stdio: definition.stdio }),
        ...(definition.options === undefined ? {} : { options: definition.options }),
        ...(definition.required === undefined ? {} : { required: definition.required }),
        ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
      },
    ]),
  );
  const entry: CommandHelpEntry = {
    spec: {
      id: spec.id,
      summary: spec.summary ?? "",
      ...(options?.aliases === undefined ? {} : { aliases: options.aliases }),
      args,
      flags: pluginFlagDefinitions(spec),
      ...(spec.strict === undefined ? {} : { strict: spec.strict }),
    },
    status: { kind: "implemented" },
  };
  return renderCommandHelp(entry, options);
};
