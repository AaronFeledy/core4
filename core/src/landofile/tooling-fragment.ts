import { Effect, Either, Schema } from "effect";

import { type LandofileIncludeError, LandofileParseError } from "@lando/sdk/errors";
import { ToolingIncludeShape } from "@lando/sdk/schema";

import { includeError } from "./include-guard.ts";

const FRAGMENT_KEYS = new Set(["tooling", "toolingIncludes"]);
const FRAGMENT_KEY_REMEDIATION =
  "A tooling fragment may only declare tooling: and toolingIncludes:; move other keys into a Landofile include.";

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const assertToolingFragment = (
  parsed: unknown,
  source: string,
  filePath: string,
): Effect.Effect<Record<string, unknown>, LandofileIncludeError | LandofileParseError> => {
  if (!isPlainRecord(parsed)) {
    return Effect.fail(
      new LandofileParseError({
        message: `Tooling include ${source} did not parse to a mapping.`,
        filePath,
        line: undefined,
        column: undefined,
      }),
    );
  }
  const offending = Object.keys(parsed).find((key) => !FRAGMENT_KEYS.has(key));
  if (offending !== undefined) {
    return Effect.fail(
      includeError({
        message: `Tooling include ${source} declares unsupported top-level key "${offending}".`,
        source,
        kind: "forbidden-field",
        remediation: FRAGMENT_KEY_REMEDIATION,
      }),
    );
  }
  if (parsed.tooling !== undefined && !isPlainRecord(parsed.tooling)) {
    return Effect.fail(
      includeError({
        message: `Tooling include ${source} declares tooling: as a non-mapping value.`,
        source,
        kind: "forbidden-field",
        remediation: FRAGMENT_KEY_REMEDIATION,
      }),
    );
  }
  if (parsed.toolingIncludes !== undefined) {
    if (!isPlainRecord(parsed.toolingIncludes)) {
      return Effect.fail(
        includeError({
          message: `Tooling include ${source} declares toolingIncludes: as a non-mapping value.`,
          source,
          kind: "forbidden-field",
          remediation: FRAGMENT_KEY_REMEDIATION,
        }),
      );
    }
    const malformed = Object.entries(parsed.toolingIncludes).find(([, entry]) =>
      Either.isLeft(
        Schema.decodeUnknownEither(ToolingIncludeShape)(entry, {
          onExcessProperty: "error",
        }),
      ),
    );
    if (malformed !== undefined) {
      return Effect.fail(
        includeError({
          message: `Tooling include ${source} has an invalid toolingIncludes.${malformed[0]} entry.`,
          source,
          kind: "forbidden-field",
          remediation: FRAGMENT_KEY_REMEDIATION,
        }),
      );
    }
  }
  return Effect.succeed(parsed);
};
