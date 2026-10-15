#!/usr/bin/env bun
import { resolve } from "node:path";

import {
  JSON_SCHEMA_NAMES,
  getJsonSchema,
  schemaDeprecationsFromJsonSchema,
} from "../sdk/src/schema/index.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const OUTPUT = resolve(import.meta.dirname, "../engine/src/deprecation/generated/schema-deprecations.ts");

const entries = JSON_SCHEMA_NAMES.flatMap((schemaName) =>
  schemaDeprecationsFromJsonSchema(getJsonSchema(schemaName)).map(({ path, notice }) => ({
    source: "schema-walk",
    kind: "schema-field",
    id: `${schemaName}${path}`,
    notice,
  })),
);

await writeFormattedOutput(
  OUTPUT,
  `/**
 * **GENERATED FILE** — do not edit by hand.
 * Regenerate via \`bun run codegen:schema-deprecations\`.
 */
import type { DeprecationNotice } from "@lando/sdk/schema";

export const SCHEMA_DEPRECATIONS = ${JSON.stringify(entries, null, 2)} as const satisfies ReadonlyArray<{
  readonly source: "schema-walk";
  readonly kind: "schema-field";
  readonly id: string;
  readonly notice: DeprecationNotice;
}>;
`,
);
console.log(
  `[build-schema-deprecations] wrote ${entries.length} entries from ${JSON_SCHEMA_NAMES.length} schemas`,
);
