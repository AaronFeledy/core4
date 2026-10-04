import { describe, expect, test } from "bun:test";
import { GlobalConfig, LandofileShape, PluginManifest, RecipeManifest } from "@lando/sdk/schema";
import {
  GlobalConfigStandardJSONSchema,
  GlobalConfigStandardSchema,
  LandofileStandardJSONSchema,
  LandofileStandardSchema,
  PluginManifestStandardJSONSchema,
  PluginManifestStandardSchema,
  RecipeManifestStandardJSONSchema,
  RecipeManifestStandardSchema,
} from "@lando/sdk/schema/standard";
import { Schema } from "effect";

const contracts = [
  { schema: LandofileStandardSchema, json: LandofileStandardJSONSchema, input: { name: "demo" } },
  { schema: GlobalConfigStandardSchema, json: GlobalConfigStandardJSONSchema, input: {} },
  {
    schema: PluginManifestStandardSchema,
    json: PluginManifestStandardJSONSchema,
    input: { name: "@lando/example", version: "1.0.0", api: 4 },
  },
  {
    schema: RecipeManifestStandardSchema,
    json: RecipeManifestStandardJSONSchema,
    input: { id: "example", title: "Example", description: "Example recipe", version: "1.0.0" },
  },
] as const;

const invalidLandofiles = [
  { input: { name: "demo", typo: true }, path: ["typo"] },
  { input: { name: 5 }, path: ["name"] },
  { input: { name: "demo", services: { web: { imgae: "nginx" } } }, path: ["services", "web", "imgae"] },
] as const;

describe("Standard Schema views", () => {
  test("decodes valid input through the public subpath", async () => {
    for (const { schema, input } of contracts) {
      // Given a valid wire value, when a Standard Schema consumer validates it.
      const result = await schema["~standard"].validate(input);
      // Then the decoded value (including defaults) matches the canonical decoder.
      expect(JSON.stringify(result)).toBe(JSON.stringify({ value: Schema.decodeUnknownSync(schema)(input) }));
      expect(schema["~standard"].vendor).toBe("effect");
      expect(schema["~standard"].version).toBe(1);
    }
  });

  test("reports invalid input paths", async () => {
    for (const { input, path } of invalidLandofiles) {
      // Given an invalid wire value, when validation runs with excess-key rejection.
      const result = await LandofileStandardSchema["~standard"].validate(input);
      // Then the consumer receives a located issue, not a successful stripped value.
      expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    }
  });

  test("collects every issue when multiple fields are invalid", async () => {
    // Given independent invalid fields, when validation runs.
    const result = await LandofileStandardSchema["~standard"].validate({ name: 5, typo: true });
    // Then errors are accumulated rather than short-circuited.
    expect(result.issues?.map((issue) => issue.path)).toEqual(expect.arrayContaining([["name"], ["typo"]]));
  });

  test("exposes input and output JSON Schema", () => {
    for (const { json } of contracts) {
      // Given a Standard JSON Schema consumer, when it requests either supported dialect.
      for (const target of ["draft-2020-12", "draft-07"] as const) {
        const input = json["~standard"].jsonSchema.input({ target });
        const output = json["~standard"].jsonSchema.output({ target });
        // Then both documents describe objects and retain their declared properties.
        expect(input).toHaveProperty("type", "object");
        expect(output).toHaveProperty("type", "object");
        expect(input).toHaveProperty("properties");
        expect(output).toHaveProperty("properties");
      }
      expect(json["~standard"].vendor).toBe("effect");
    }
  });

  test("does not attach Standard views to canonical schemas", () => {
    // Given the views have been imported, when inspecting canonical schema objects.
    for (const schema of [LandofileShape, GlobalConfig, PluginManifest, RecipeManifest]) {
      // Then importing this subpath has not changed another consumer's schema instance.
      expect(schema).not.toHaveProperty("~standard");
    }
  });

  test("imports only the four direct schema modules rather than the barrel", async () => {
    // Given the subpath source, when collecting its module dependencies.
    const source = await Bun.file(new URL("../../src/schema/standard.ts", import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    // Then neither a barrel nor another SDK module can pull in the whole schema registry.
    expect(imports.sort()).toEqual(["./config.ts", "./landofile.ts", "./plugin.ts", "./recipe.ts", "effect"]);
  });
});
