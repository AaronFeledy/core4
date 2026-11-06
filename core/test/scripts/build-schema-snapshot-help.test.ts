import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { HelpCatalogResult } from "../../src/cli/compiled-help.ts";
import { HelpTargetResult } from "../../src/cli/help-target.ts";

test("schema-only cli:help publishes both machine help shapes without registering an executable", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const index = await Bun.file(resolve(root, "dist/command-schemas/index.json")).json();
  const artifact = await Bun.file(resolve(root, index["cli:help"])).json();
  expect(index["cli:help"]).toBe("dist/command-schemas/cli-help.json");
  expect(artifact).toEqual(
    getJsonSchemaWithDeprecations(Schema.Union([HelpCatalogResult, HelpTargetResult])),
  );
  expect(await Bun.file(resolve(root, "core/dist/command-schemas/cli-help.json")).json()).toEqual(artifact);
  expect(builtInCommandEntries.some(({ spec }) => spec.id === "cli:help")).toBe(false);
});
