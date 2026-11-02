/**
 * Pure `--type` value parser for config write verbs. Parses a raw
 * CLI string into an encoded value per the requested type. `string` is the
 * identity default; `number`/`boolean` are strict scalar parses; `json` is
 * `JSON.parse`; `yaml` handles YAML scalars and JSON-compatible flow
 * collections (structured non-JSON input should use `--type json`).
 */

import { MinimalYamlError, parseScalar } from "@lando/paths/yaml-min";
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
  try {
    const value = parseScalar(raw);
    if (typeof value === "number" && !Number.isFinite(value)) {
      return fail("yaml", raw, "The value must be a finite number.");
    }
    return Result.succeed(value);
  } catch (error) {
    if (!(error instanceof MinimalYamlError)) throw error;
    return fail("yaml", raw, error.message);
  }
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
