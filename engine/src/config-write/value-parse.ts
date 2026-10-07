/**
 * Pure `--type` value parser for config write verbs. Parses a raw
 * CLI string into an encoded value per the requested type. `string` is the
 * identity default; `number`/`boolean` are strict scalar parses; `json` is
 * `JSON.parse`; `yaml` handles YAML scalars and JSON-compatible flow
 * collections (structured non-JSON input should use `--type json`).
 */

import { causeMessage } from "@lando/sdk/errors";
import { Result } from "effect";

export type ValueType = "string" | "number" | "boolean" | "json" | "yaml";

export interface ValueParseFailure {
  readonly type: ValueType;
  readonly raw: string;
  readonly message: string;
}

const fail = (type: ValueType, raw: string, message: string): Result.Result<never, ValueParseFailure> =>
  Result.fail({ type, raw, message });

const parseYamlScalar = (raw: string): Result.Result<unknown, ValueParseFailure> => {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~") return Result.succeed(null);
  if (trimmed === "true") return Result.succeed(true);
  if (trimmed === "false") return Result.succeed(false);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return Result.succeed(JSON.parse(trimmed) as unknown);
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
    return Result.succeed(trimmed.slice(1, -1));
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return Result.succeed(num);
  }
  return Result.succeed(trimmed);
};

export const parseTypedValue = (raw: string, type: ValueType): Result.Result<unknown, ValueParseFailure> => {
  switch (type) {
    case "string":
      return Result.succeed(raw);
    case "number": {
      const num = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(num)) {
        return fail("number", raw, `\`${raw}\` is not a finite number.`);
      }
      return Result.succeed(num);
    }
    case "boolean": {
      const t = raw.trim();
      if (t === "true") return Result.succeed(true);
      if (t === "false") return Result.succeed(false);
      return fail("boolean", raw, `\`${raw}\` is not a boolean (expected \`true\` or \`false\`).`);
    }
    case "json":
      try {
        return Result.succeed(JSON.parse(raw) as unknown);
      } catch (cause) {
        return fail("json", raw, `\`${raw}\` is not valid JSON: ${causeMessage(cause)}`);
      }
    case "yaml":
      return parseYamlScalar(raw);
  }
};
