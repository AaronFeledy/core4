import { expect, test } from "bun:test";

import { JSON_SCHEMA_NAMES, getJsonSchema, schemaDeprecationsFromJsonSchema } from "@lando/sdk/schema";
import { SCHEMA_DEPRECATIONS } from "../../src/deprecation/generated/schema-deprecations.ts";

test("preserves the complete JSON-schema catalog when deprecations are baked at build time", () => {
  // Given: every public schema, including schemas with no deprecations.
  const expected = JSON_SCHEMA_NAMES.flatMap((schemaName) =>
    schemaDeprecationsFromJsonSchema(getJsonSchema(schemaName)).map(({ path, notice }) => ({
      source: "schema-walk",
      kind: "schema-field",
      id: `${schemaName}${path}`,
      notice,
    })),
  );

  // When: runtime loads the derived catalog instead of generating JSON Schema.
  const actual: ReadonlyArray<(typeof expected)[number]> = SCHEMA_DEPRECATIONS;

  // Then: sources, kinds, ids, paths, notices, and ordering are unchanged.
  expect(actual).toEqual(expected);
});
