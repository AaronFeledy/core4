import { Schema } from "effect";

const FLAG_VALUE_ISSUES = ["missing", "empty", "invalid_integer", "repeated"] as const;
type FlagValueIssue = (typeof FLAG_VALUE_ISSUES)[number];

// Bare `--mount-cwd` normalizes to an empty value to select its default target.
const EMPTY_VALUE_FLAGS_BY_COMMAND: Readonly<Record<string, ReadonlyArray<string>>> = {
  "apps:scratch:start": ["mount-cwd"],
};

export class MalformedCliFlagValueError extends Schema.TaggedError<MalformedCliFlagValueError>()(
  "MalformedCliFlagValueError",
  {
    message: Schema.String,
    flag: Schema.String,
    issue: Schema.Literal(...FLAG_VALUE_ISSUES),
    remediation: Schema.String,
  },
) {}

type FlagDefinition = {
  readonly name: string;
  readonly boolean: boolean;
  readonly multiple: boolean;
};

const flagDefinitionsByToken = (
  definitions: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, FlagDefinition> => {
  const byToken = new Map<string, FlagDefinition>();
  for (const [name, candidate] of Object.entries(definitions)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const definition = {
      name,
      boolean: "type" in candidate && candidate.type === "boolean",
      multiple: "multiple" in candidate && candidate.multiple === true,
    };
    byToken.set(`--${name}`, definition);
    if ("char" in candidate && typeof candidate.char === "string") {
      byToken.set(`-${candidate.char}`, definition);
    }
    if ("aliases" in candidate && Array.isArray(candidate.aliases)) {
      for (const alias of candidate.aliases) {
        if (typeof alias === "string") byToken.set(`--${alias}`, definition);
      }
    }
  }
  return byToken;
};

const flagToken = (arg: string): string => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

const malformedFlagValue = (flag: string, issue: FlagValueIssue): MalformedCliFlagValueError => {
  const option = `--${flag}`;
  const remediation =
    issue === "invalid_integer"
      ? `Supply ${option} with a whole integer.`
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
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") break;
    const definition = byToken.get(flagToken(arg));
    if (definition === undefined || definition.boolean) continue;
    if (seen.has(definition.name) && !definition.multiple) {
      return malformedFlagValue(definition.name, "repeated");
    }
    seen.add(definition.name);

    const equalsIndex = arg.indexOf("=");
    const value = equalsIndex === -1 ? argv[index + 1] : arg.slice(equalsIndex + 1);
    if (value === undefined) return malformedFlagValue(definition.name, "missing");
    if (value === "" && !allowedEmptyFlags.includes(definition.name)) {
      return malformedFlagValue(definition.name, "empty");
    }
    if (equalsIndex === -1 && byToken.has(flagToken(value))) {
      return malformedFlagValue(definition.name, "missing");
    }
    if (definition.name === "tail" && !/^-?\d+$/.test(value)) {
      return malformedFlagValue(definition.name, "invalid_integer");
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
