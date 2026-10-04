import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { LandofileShape, RecipeManifest, getJsonSchema } from "@lando/sdk/schema";
import { LandofileStandardSchema, RecipeManifestStandardSchema } from "@lando/sdk/schema/standard";
import {
  Effect,
  Exit,
  JsonSchema,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaRepresentation,
} from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";
import { importableNode } from "./landofile-parity-json-schema-fixup.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function isJsonSchema(value: unknown): value is JsonSchema.JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const root = new URL("../../../", import.meta.url);
const parseOptions = { onExcessProperty: "error", errors: "all" } as const;

const curated = [
  { id: "unknown-top-level", input: { name: "demo", typo: true } },
  { id: "unknown-service-key", input: { name: "demo", services: { web: { imgae: "nginx" } } } },
  { id: "wrong-name-type", input: { name: 5 } },
  { id: "port-out-of-range", input: { name: "demo", router: { httpPort: 70000 } } },
  { id: "optional-null", input: { name: "demo", router: null } },
  { id: "compose-port-out-of-range", input: { name: "demo", services: { web: { ports: [70000] } } } },
  { id: "empty-build", input: { name: "demo", services: { web: { build: {} } } } },
  {
    id: "conflicting-build-files",
    input: {
      name: "demo",
      services: { web: { build: { dockerfile: "Dockerfile", dockerfile_inline: "FROM nginx" } } },
    },
  },
  {
    id: "reserved-map-key",
    input: JSON.parse('{"name":"demo","services":{"web":{"environment":{"__proto__":"value"}}}}'),
  },
  { id: "invalid-semver-range", input: { name: "demo", lando: "not-semver" } },
] as const;

const curatedValid = [
  {
    id: "extension-values",
    input: { name: "demo", "x-meta": { arbitrary: [null, 3] }, services: { web: { "x-meta": true } } },
  },
  {
    id: "both-build-phases",
    input: { name: "demo", services: { web: { build: { artifact: "echo artifact", app: "echo app" } } } },
  },
  {
    id: "inline-build",
    input: { name: "demo", services: { web: { build: { dockerfile_inline: "FROM nginx" } } } },
  },
  { id: "event-steps", input: { name: "demo", events: { "pre-start": ["echo ready"] } } },
] as const;

const INEXPRESSIBLE = [
  {
    id: "compose-port-out-of-range",
    check: "Compose port normalization range",
    reason:
      "The ports input union permits numbers; its decoding transform enforces 1..65535 after JSON Schema projection.",
  },
  {
    id: "invalid-semver-range",
    check: "npm semver range",
    reason: "The lando string uses semver.validRange, which has no JSON Schema projection.",
  },
] as const;

const SKIPPED = [
  { suffix: ".lando.ts", reason: "TypeScript program, not a YAML Landofile document." },
  { suffix: ".lando.local.yml", reason: "Partial overlay layer, not a canonical Landofile document." },
  { suffix: ".lando.recipe.yml", reason: "Recipe overlay layer, not a canonical Landofile document." },
  { suffix: ".lando.tasks.yml", reason: "Tooling include fragment, not a canonical Landofile document." },
] as const;

function issueDetails(issues: readonly StandardSchemaV1.Issue[]) {
  return issues.map(({ message, path }) => ({
    message,
    path: (path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)),
  }));
}

function decoderIssues(decoded: Result.Result<unknown, Schema.SchemaError>) {
  return Result.isFailure(decoded)
    ? issueDetails(SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues)
    : [];
}

test("published JSON Schema and Standard Schema agree with the Landofile decoder", async () => {
  // Given all guide/recipe Landofile data plus explicitly invalid boundary inputs.
  // The published 2020-12 document is getJsonSchema("LandofileShape"). The
  // generated snapshot must be that same document. The draft-07 editor artifact
  // is derived from it, so this test does not round-trip the editor dialect.
  const generated = getJsonSchema("LandofileShape");
  const snapshot = JSON.parse(
    await Bun.file(new URL("../../../dist/schemas/landofile-shape.json", import.meta.url)).text(),
  );
  expect(isJsonSchema(generated)).toBe(true);
  if (!isJsonSchema(generated)) return;
  expect(generated.$schema).toBe(DRAFT_2020_12);
  expect(snapshot).toEqual(generated);
  const jsonSchema = SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(generated),
    {
      patterns: "apply",
      onEnter: importableNode,
    },
  );
  // Schema.Top erases DecodingServices to unknown. The imported document requires
  // none, so the closed runner is the decodeUnknownResult equivalent.
  const decodeJsonEffect = SchemaParser.decodeUnknownEffect(jsonSchema) as (
    input: unknown,
    options?: Parameters<typeof SchemaParser.decodeUnknownEffect>[1],
  ) => Effect.Effect<unknown, SchemaIssue.Issue>;
  const decodeJson = (input: unknown) =>
    Exit.isSuccess(Effect.runSyncExit(decodeJsonEffect(input, parseOptions)));
  const paths = [
    ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.yml").scanSync({
      cwd: fileURLToPath(root),
      dot: true,
    }),
    ...new Bun.Glob("recipes/**/.lando.yml").scanSync({ cwd: fileURLToPath(root), dot: true }),
  ].sort();
  const fixtures = await Promise.all(
    paths.map(async (id) => ({
      id,
      input: Bun.YAML.parse(await Bun.file(new URL(id, root)).text()),
    })),
  );
  const disagreements: string[] = [];
  const observedExceptions: string[] = [];
  let valid = 0;
  let invalid = 0;

  // When each independent surface receives the same raw parsed data.
  for (const { id, input } of [...fixtures, ...curated, ...curatedValid]) {
    const decoded = Schema.decodeUnknownResult(LandofileShape)(input, parseOptions);
    const standard = await LandofileStandardSchema["~standard"].validate(input);
    const accepted = Result.isSuccess(decoded);
    if (paths.includes(id)) accepted ? valid++ : invalid++;
    if (curated.some((entry) => entry.id === id)) expect(accepted, id).toBe(false);
    if (curatedValid.some((entry) => entry.id === id)) expect(accepted, id).toBe(true);

    // Then Standard Schema preserves both the verdict and every issue path/message.
    // suggestion is ignored; ValidationIssue may add a closest-key hint the formatter does not.
    expect(standard.issues === undefined, id).toBe(accepted);
    expect(issueDetails(standard.issues ?? []), id).toEqual(decoderIssues(decoded));

    // And the published JSON Schema document agrees, except for the named inexpressible checks.
    const jsonAccepted = decodeJson(input);
    if (jsonAccepted !== accepted) {
      const exception = INEXPRESSIBLE.find((entry) => entry.id === id);
      if (exception && jsonAccepted && !accepted) observedExceptions.push(id);
      else disagreements.push(`${id}: decoder=${accepted}, json=${jsonAccepted}`);
    }
  }
  expect(disagreements).toEqual([]);
  expect(observedExceptions.sort()).toEqual(INEXPRESSIBLE.map(({ id }) => id).sort());
  expect(valid).toBeGreaterThan(100);
  expect(valid + invalid).toBe(paths.length);
  console.info(
    `Landofile parity fixtures: ${valid} valid, ${invalid} invalid; ${curated.length} curated invalid`,
  );
});

test("skips non-Landofile fixture files only when a reason is listed", () => {
  // Given every dotted Landofile-shaped fixture, when it is not a canonical .lando.yml.
  const discovered = [
    ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.*").scanSync({ cwd: fileURLToPath(root), dot: true }),
    ...new Bun.Glob("recipes/**/.lando.*").scanSync({ cwd: fileURLToPath(root), dot: true }),
  ];
  const skipped = discovered.filter((path) => !path.endsWith(".lando.yml"));
  const unclassified = skipped.filter((path) => !SKIPPED.some((entry) => path.endsWith(entry.suffix)));
  // Then each skip has a listed reason, and every listed reason still matches a file.
  expect(unclassified).toEqual([]);
  for (const entry of SKIPPED)
    expect(
      skipped.some((path) => path.endsWith(entry.suffix)),
      entry.reason,
    ).toBe(true);
  console.info(`Landofile parity skipped: ${skipped.length}`);
});

test("bundled recipe manifests agree with RecipeManifest", async () => {
  // Given bundled recipe.yml files. Empty YAML maps parse as null, so a manifest may be rejected.
  const paths = [
    ...new Bun.Glob("recipes/**/recipe.yml").scanSync({ cwd: fileURLToPath(root), dot: true }),
  ].sort();
  expect(paths.length).toBeGreaterThan(0);
  for (const id of paths) {
    const input = Bun.YAML.parse(await Bun.file(new URL(id, root)).text());
    const decoded = Schema.decodeUnknownResult(RecipeManifest)(input, parseOptions);
    const standard = await RecipeManifestStandardSchema["~standard"].validate(input);
    const accepted = Result.isSuccess(decoded);
    // Then the Standard Schema view agrees on accept/reject and on every issue path and message.
    expect(standard.issues === undefined, id).toBe(accepted);
    expect(issueDetails(standard.issues ?? []), id).toEqual(decoderIssues(decoded));
  }
});
