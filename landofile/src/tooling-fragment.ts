import { Effect, Either, Schema } from "effect";

import { type LandofileIncludeError, LandofileParseError } from "@lando/sdk/errors";
import { ToolingIncludeShape } from "@lando/sdk/schema";

import { includeError } from "./include-guard.ts";

const FRAGMENT_KEYS = new Set(["tooling", "toolingIncludes"]);
const TOOLING_INCLUDE_KEYS = new Set(Object.keys(ToolingIncludeShape.fields));
const FRAGMENT_KEY_REMEDIATION =
  "A tooling fragment may only declare tooling: and toolingIncludes:; move other keys into a Landofile include.";
const ENTRY_FIELD_REMEDIATION = `A toolingIncludes: entry accepts only ${[...TOOLING_INCLUDE_KEYS].join(", ")}; dir: and checksum: are not part of the tooling-include shape.`;

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
    for (const [name, entry] of Object.entries(parsed.toolingIncludes)) {
      const unsupported = isPlainRecord(entry)
        ? Object.keys(entry).find((key) => !TOOLING_INCLUDE_KEYS.has(key))
        : undefined;
      if (unsupported !== undefined) {
        return Effect.fail(
          includeError({
            message: `Tooling include ${source} sets unsupported field "${unsupported}" on toolingIncludes.${name}.`,
            source,
            kind: "forbidden-field",
            remediation: ENTRY_FIELD_REMEDIATION,
          }),
        );
      }
      if (
        Either.isLeft(Schema.decodeUnknownEither(ToolingIncludeShape)(entry, { onExcessProperty: "error" }))
      ) {
        return Effect.fail(
          includeError({
            message: `Tooling include ${source} has an invalid toolingIncludes.${name} entry.`,
            source,
            kind: "forbidden-field",
            remediation: ENTRY_FIELD_REMEDIATION,
          }),
        );
      }
    }
  }
  return Effect.succeed(parsed);
};
