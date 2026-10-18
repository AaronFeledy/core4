import { Effect, Predicate } from "effect";

import { type LandofileIncludeError, LandofileParseError } from "@lando/sdk/errors";
import { ToolingIncludeShape } from "@lando/sdk/schema";

import { includeError } from "./include-guard.ts";

const FRAGMENT_KEYS = new Set(["tooling", "toolingIncludes"]);
const TOOLING_INCLUDE_KEYS = new Set(Object.keys(ToolingIncludeShape.fields));
const FRAGMENT_KEY_REMEDIATION =
  "A tooling fragment may only declare tooling: and toolingIncludes:; move other keys into a Landofile include.";
const ENTRY_FIELD_REMEDIATION = `A toolingIncludes: entry accepts only ${[...TOOLING_INCLUDE_KEYS].join(", ")}; dir: and checksum: are not part of the tooling-include shape.`;

export const assertToolingFragment = (
  parsed: unknown,
  source: string,
  filePath: string,
): Effect.Effect<Record<string, unknown>, LandofileIncludeError | LandofileParseError> => {
  if (!Predicate.isObject(parsed)) {
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
  if (Predicate.isObject(parsed.toolingIncludes)) {
    for (const [name, entry] of Object.entries(parsed.toolingIncludes)) {
      const unsupported = Predicate.isObject(entry)
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
    }
  }
  return Effect.succeed(parsed);
};
