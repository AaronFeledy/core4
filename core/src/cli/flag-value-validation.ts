import { Schema } from "effect";

const FLAG_VALUE_ISSUES = [
  "missing",
  "empty",
  "invalid_integer",
  "invalid_option",
  "unexpected",
  "repeated",
] as const;
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
  readonly options: ReadonlyArray<string>;
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
      options:
        "options" in candidate && Array.isArray(candidate.options)
          ? candidate.options.filter((option): option is string => typeof option === "string")
          : [],
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

export const normalizeCliFlagTokens = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const byToken = flagDefinitionsByToken(definitions);
  const normalized: string[] = [];
  let optionsEnded = false;

  for (const arg of argv) {
    if (optionsEnded || arg === "--" || !arg.startsWith("-") || arg.startsWith("--") || arg.length <= 2) {
      normalized.push(arg);
      if (arg === "--") optionsEnded = true;
      continue;
    }

    const expanded: string[] = [];
    const bundle = arg.slice(1);
    let offset = 0;
    let recognized = true;
    while (offset < bundle.length) {
      const token = `-${bundle[offset]}`;
      const definition = byToken.get(token);
      if (definition === undefined) {
        recognized = false;
        break;
      }
      expanded.push(token);
      offset += 1;
      if (definition.boolean) {
        const attached = bundle.slice(offset);
        const nextToken = attached.length === 0 ? undefined : byToken.get(`-${attached[0]}`);
        if (attached.length > 0 && nextToken === undefined) {
          expanded[expanded.length - 1] =
            `${token}=${attached.startsWith("=") ? attached.slice(1) : attached}`;
          offset = bundle.length;
        }
        continue;
      }

      const attached = bundle.slice(offset);
      if (attached.length > 0) expanded.push(attached.startsWith("=") ? attached.slice(1) : attached);
      offset = bundle.length;
    }
    normalized.push(...(recognized ? expanded : [arg]));
  }

  return normalized;
};

const malformedFlagValue = (flag: string, issue: FlagValueIssue): MalformedCliFlagValueError => {
  const option = `--${flag}`;
  const remediation =
    issue === "invalid_integer"
      ? `Supply ${option} with a whole integer.`
      : issue === "invalid_option"
        ? `Supply ${option} with one of its declared values.`
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
    if (definition.name === "tail" && !/^-?\d+$/.test(value)) {
      return malformedFlagValue(definition.name, "invalid_integer");
    }
    if (definition.options.length > 0 && !definition.options.includes(value)) {
      return malformedFlagValue(definition.name, "invalid_option");
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
