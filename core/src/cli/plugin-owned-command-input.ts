import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import {
  type CommandHelpEntry,
  type CommandHelpOptions,
  type CommandHelpSpec,
  renderCommandHelp,
} from "./cli-help";
import { commandTailIndex, withCommandRemainderSeparator } from "./command-tail";
import { parseFlagsAndPositionals, setParsedFlag } from "./compiled-argv";
import { normalizeCliFlagTokens } from "./flag-tokens";
import { validateCommandCliFlags } from "./flag-value-validation";
import { pluginFlagDefinitions, pluginTailPolicy } from "./plugin-flag-definitions";

export const pluginOwnedCliFlagError = (
  spec: Pick<ExecutableCommandSpec, "id" | "flags" | "strict" | "args">,
  argv: ReadonlyArray<string>,
) =>
  validateCommandCliFlags({
    commandId: spec.id,
    argv,
    definitions: pluginFlagDefinitions(spec),
    allowUnknownFlags: spec.strict === false,
    tailPolicy: pluginTailPolicy(spec),
  });

/** The tokens of a plugin command's argv Lando may read: those before its verbatim tail or first `--`. */
export const pluginDispatcherArgv = (
  spec: Pick<ExecutableCommandSpec, "flags" | "args" | "strict"> | undefined,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const policy = spec === undefined ? undefined : pluginTailPolicy(spec);
  if (policy?.kind === "command") return argv.slice(0, commandTailIndex(argv, policy.flags));
  const separator = argv.indexOf("--");
  return separator === -1 ? argv : argv.slice(0, separator);
};

export const pluginHelpRequested = (
  spec: Pick<ExecutableCommandSpec, "flags" | "args" | "strict"> | undefined,
  argv: ReadonlyArray<string>,
): boolean => pluginDispatcherArgv(spec, argv).some((token) => token === "--help" || token === "-h");

export const pluginOwnedCommandInputFromArgv = (
  spec: Pick<ExecutableCommandSpec, "flags" | "args" | "strict">,
  argv: ReadonlyArray<string>,
): {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly raw: ReadonlyArray<string>;
} => {
  const flagDefinitions = pluginFlagDefinitions(spec);
  const commandArgv =
    pluginTailPolicy(spec).kind === "command" ? withCommandRemainderSeparator(argv, flagDefinitions) : argv;
  const normalizedArgv = normalizeCliFlagTokens(commandArgv, flagDefinitions);
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
