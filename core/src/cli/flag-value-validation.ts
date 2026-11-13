import { MalformedCliFlagValueError, UnknownCliFlagError } from "@lando/sdk/errors";
import { commandTailIndex } from "./command-tail";
import { flagDefinitionsByToken, normalizeCliFlagTokens } from "./flag-tokens";
import type { TailPolicy } from "./invocation";

type FlagValueIssue = MalformedCliFlagValueError["issue"];

// Bare `--mount-cwd` normalizes to an empty value to select its default target.
const EMPTY_VALUE_FLAGS_BY_COMMAND: Readonly<Record<string, ReadonlyArray<string>>> = {
  "apps:scratch:start": ["mount-cwd"],
};

const flagToken = (arg: string): string => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

export const validateUnknownCliFlags = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): UnknownCliFlagError | undefined => {
  const byToken = flagDefinitionsByToken(definitions);
  const normalizedArgv = normalizeCliFlagTokens(argv, definitions);
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    const token = flagToken(arg);
    const definition = byToken.get(token);
    if (definition !== undefined) {
      if (!definition.boolean && !arg.includes("=")) index += 1;
      continue;
    }
    const reportedToken = token.startsWith("--") ? token : token.slice(0, 2);
    return new UnknownCliFlagError({
      message: `Nonexistent flag: ${reportedToken}`,
      flag: reportedToken,
      remediation: "Remove the unknown flag or run the command with --help to inspect supported flags.",
    });
  }
  return undefined;
};

const malformedFlagValue = (
  flag: string,
  issue: FlagValueIssue,
  options: ReadonlyArray<string> = [],
  min?: number,
): MalformedCliFlagValueError => {
  const option = `--${flag}`;
  const remediation =
    issue === "invalid_integer"
      ? min === undefined
        ? `Supply ${option} with a whole integer.`
        : `Supply ${option} with a whole integer of at least ${min}.`
      : issue === "invalid_option"
        ? options.length > 0
          ? `Supply ${option} with one of: ${options.join(", ")}.`
          : `Supply ${option} with one of its declared values.`
        : issue === "unexpected"
          ? `Do not supply a value for ${option}.`
          : issue === "repeated"
            ? `Supply ${option} only once.`
            : `Supply a non-empty value for ${option}.`;
  return new MalformedCliFlagValueError({
    message: `${option} has a malformed value.`,
    flag,
    issue,
    remediation,
  });
};

export const validateCliFlagValues = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
  allowedEmptyFlags: ReadonlyArray<string> = [],
): MalformedCliFlagValueError | undefined => {
  const byToken = flagDefinitionsByToken(definitions);
  const normalizedArgv = normalizeCliFlagTokens(argv, definitions);
  const seen = new Set<string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === undefined || arg === "--") break;
    const definition = byToken.get(flagToken(arg));
    if (definition === undefined) continue;
    const equalsIndex = arg.indexOf("=");
    if (definition.boolean) {
      if (equalsIndex !== -1) return malformedFlagValue(definition.name, "unexpected");
      continue;
    }
    if (seen.has(definition.name) && !definition.multiple) {
      return malformedFlagValue(definition.name, "repeated");
    }
    seen.add(definition.name);

    const value = equalsIndex === -1 ? normalizedArgv[index + 1] : arg.slice(equalsIndex + 1);
    if (value === undefined) return malformedFlagValue(definition.name, "missing");
    if (value === "" && !allowedEmptyFlags.includes(definition.name)) {
      return malformedFlagValue(definition.name, "empty");
    }
    if (equalsIndex === -1 && byToken.has(flagToken(value))) {
      return malformedFlagValue(definition.name, "missing");
    }
    if (
      definition.integer &&
      (!/^-?\d+$/.test(value) ||
        !Number.isInteger(Number(value)) ||
        (definition.min !== undefined && Number(value) < definition.min))
    ) {
      return malformedFlagValue(definition.name, "invalid_integer", [], definition.min);
    }
    if (definition.options.length > 0 && !definition.options.includes(value)) {
      return malformedFlagValue(definition.name, "invalid_option", definition.options);
    }
    if (equalsIndex === -1) index += 1;
  }
  return undefined;
};

export const validateCommandFlagValues = (
  commandId: string,
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): MalformedCliFlagValueError | undefined =>
  validateCliFlagValues(argv, definitions, EMPTY_VALUE_FLAGS_BY_COMMAND[commandId]);

export const validateCommandCliFlags = (input: {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly allowUnknownFlags: boolean;
  /** How the command owns its tail; `all` validates nothing after the command name. */
  readonly tailPolicy?: TailPolicy;
  /** The spelling remediation names; defaults to the canonical id. */
  readonly commandName?: string;
}): MalformedCliFlagValueError | UnknownCliFlagError | undefined => {
  if (input.tailPolicy?.kind === "all") return undefined;
  const commandTail = input.tailPolicy?.kind === "command";
  const argv = commandTail
    ? input.argv.slice(0, commandTailIndex(input.argv, input.definitions))
    : input.argv;
  const unknown =
    commandTail || !input.allowUnknownFlags ? validateUnknownCliFlags(argv, input.definitions) : undefined;
  if (unknown !== undefined) {
    if (!commandTail) return unknown;
    const name = input.commandName ?? input.commandId;
    return new UnknownCliFlagError({
      message: unknown.message,
      flag: unknown.flag,
      remediation: `Put the command after \`--\`: \`lando ${name} -- <command>\`. Run \`lando ${name} --help\` for its flags.`,
    });
  }
  return validateCommandFlagValues(input.commandId, argv, input.definitions);
};
