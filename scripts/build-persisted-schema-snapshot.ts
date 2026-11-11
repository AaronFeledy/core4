#!/usr/bin/env bun
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getJsonSchemaWithDeprecations } from "../sdk/src/schema/json-schema-deprecations.ts";
import { formatGeneratedPaths } from "./_codegen-output.ts";
import { INTERNAL_PERSISTED_STORES } from "./schema-compatibility/internal-stores.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = resolve(REPO_ROOT, "dist/persisted-schemas");

export const buildPersistedSchemaSnapshot = async (): Promise<void> => {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const index = INTERNAL_PERSISTED_STORES.map(({ id, version }) => ({
    id,
    version,
    jsonSchemaPath: `dist/persisted-schemas/${id}.json`,
  }));
  for (const { id, schema } of INTERNAL_PERSISTED_STORES) {
    // StateStore's decoder ignores excess properties; snapshot that same input contract.
    const jsonSchema = getJsonSchemaWithDeprecations(schema, { onExcessProperty: "ignore" });
    await Bun.write(resolve(OUTPUT_DIR, `${id}.json`), `${JSON.stringify(jsonSchema, null, 2)}\n`);
  }
  await Bun.write(resolve(OUTPUT_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  const filenames = new Set(["index.json", ...index.map(({ id }) => `${id}.json`)]);
  for (const entry of await readdir(OUTPUT_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !filenames.has(entry.name)) {
      await rm(resolve(OUTPUT_DIR, entry.name));
    }
  }
  await formatGeneratedPaths([OUTPUT_DIR]);
};

if (import.meta.main) {
  await buildPersistedSchemaSnapshot();
  console.log(
    `[build-persisted-schema-snapshot] wrote ${INTERNAL_PERSISTED_STORES.length} persisted schemas`,
  );
}
