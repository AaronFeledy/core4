/**
 * Pure `--type` value parser for config write verbs (§8.2.1). Parses a raw
 * CLI string into an encoded value per the requested type. `string` is the
 * identity default; `number`/`boolean` are strict scalar parses; `json` is
 * `JSON.parse`; `yaml` handles YAML scalars and JSON-compatible flow
 * collections (structured non-JSON input should use `--type json`).
 */

import { Either } from "effect";

export type ValueType = "string" | "number" | "boolean" | "json" | "yaml";

export interface ValueParseFailure {
  readonly type: ValueType;
  readonly raw: string;
  readonly message: string;
}

const fail = (type: ValueType, raw: string, message: string): Either.Either<never, ValueParseFailure> =>
  Either.left({ type, raw, message });

const parseYamlScalar = (raw: string): Either.Either<unknown, ValueParseFailure> => {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~") return Either.right(null);
  if (trimmed === "true") return Either.right(true);
  if (trimmed === "false") return Either.right(false);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return Either.right(JSON.parse(trimmed) as unknown);
    } catch {
      return fail(
        "yaml",
        raw,
        `Could not parse YAML flow value \`${trimmed}\`. Use \`--type json\` for complex structures.`,
      );
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return Either.right(trimmed.slice(1, -1));
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return Either.right(num);
  }
  return Either.right(trimmed);
};

export const parseTypedValue = (raw: string, type: ValueType): Either.Either<unknown, ValueParseFailure> => {
  switch (type) {
    case "string":
      return Either.right(raw);
    case "number": {
      const num = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(num)) {
        return fail("number", raw, `\`${raw}\` is not a finite number.`);
      }
      return Either.right(num);
    }
    case "boolean": {
      const t = raw.trim();
      if (t === "true") return Either.right(true);
      if (t === "false") return Either.right(false);
      return fail("boolean", raw, `\`${raw}\` is not a boolean (expected \`true\` or \`false\`).`);
    }
    case "json":
      try {
        return Either.right(JSON.parse(raw) as unknown);
      } catch (cause) {
        return fail(
          "json",
          raw,
          `\`${raw}\` is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    case "yaml":
      return parseYamlScalar(raw);
  }
};
