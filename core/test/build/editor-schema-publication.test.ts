import { beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { LANDOFILE_EDITOR_SCHEMA_URL, getEditorJsonSchema } from "@lando/sdk/schema";
import { JsonSchema } from "effect";

const root = resolve(import.meta.dirname, "../../..");

beforeAll(async () => {
  const result = Bun.spawn(["bun", "run", "codegen:schema-snapshot"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([result.exited, new Response(result.stderr).text()]);
  expect(code, stderr).toBe(0);
}, 120_000);

test("publishes the Landofile editor artifact at the SDK modeline URL", async () => {
  const config = await Bun.file(resolve(root, "docs/astro.config.mjs")).text();
  const site = /site:\s*"([^"]+)"/.exec(config)?.[1];
  const base = /base:\s*"([^"]+)"/.exec(config)?.[1];
  if (site === undefined || base === undefined) throw new Error("Astro site and base must be configured");

  const publishedUrl = new URL(`${base}schemas/landofile.schema.json`, site).href;

  expect(LANDOFILE_EDITOR_SCHEMA_URL).toBe(publishedUrl);
});

test.each([
  ["LandofileShape", "landofile.schema.json"],
  ["GlobalConfig", "global-config.schema.json"],
] as const)("publishes the generated %s editor projection", async (name, filename) => {
  const file = Bun.file(resolve(root, "docs/public/schemas", filename));

  const artifact = await file.json();

  expect(artifact).toEqual(getEditorJsonSchema(name));
  expect(artifact).toMatchObject({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    additionalProperties: false,
  });
  expect(artifact).not.toHaveProperty("$defs");
});
