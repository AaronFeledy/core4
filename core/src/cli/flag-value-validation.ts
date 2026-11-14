import { MalformedCliFlagValueError, UnknownCliFlagError } from "@lando/sdk/errors";
import { BARE_VALUE_FLAGS_BY_COMMAND } from "./flag-claims";
import { flagDefinitionsByToken, normalizeCliFlagTokens } from "./flag-tokens";
import { matchLandoFlag } from "./lando-flags";

type FlagValueIssue = MalformedCliFlagValueError["issue"];

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
    // A flag-shaped Lando occurrence in the value slot is a missing value: the
    // walker gave the adjacent token to this flag, never to Lando.
    if (equalsIndex === -1 && matchLandoFlag(value, undefined) !== undefined) {
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
  validateCliFlagValues(argv, definitions, BARE_VALUE_FLAGS_BY_COMMAND[commandId]);

export const validateCommandCliFlags = (input: {
  readonly commandId: string;
  /** The command's lead only: every token before its verbatim tail or first `--`. */
  readonly argv: ReadonlyArray<string>;
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly allowUnknownFlags: boolean;
  /** Present when the command owns a tail; the remediation names it. */
  readonly commandTail?: { readonly commandName: string };
}): MalformedCliFlagValueError | UnknownCliFlagError | undefined => {
  const commandTail = input.commandTail;
  const unknown =
    commandTail !== undefined || !input.allowUnknownFlags
      ? validateUnknownCliFlags(input.argv, input.definitions)
      : undefined;
  if (unknown !== undefined) {
    if (commandTail === undefined) return unknown;
    return new UnknownCliFlagError({
      message: unknown.message,
      flag: unknown.flag,
      remediation: `Put the command after \`--\`: \`lando ${commandTail.commandName} -- <command>\`. Run \`lando ${commandTail.commandName} --help\` for its flags.`,
    });
  }
  return validateCommandFlagValues(input.commandId, input.argv, input.definitions);
};
