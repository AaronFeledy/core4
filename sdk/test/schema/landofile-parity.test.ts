import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  LandofileAuthoringShape,
  LandofileShape,
  RecipeManifest,
  getEditorJsonSchema,
  getJsonSchema,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { LandofileStandardSchema, RecipeManifestStandardSchema } from "@lando/sdk/schema/standard";
import {
  Effect,
  Exit,
  JsonSchema,
  Result,
  Schema,
  type SchemaIssue,
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
  { id: "empty-healthcheck-command", input: { name: "demo", services: { web: { healthcheck: "" } } } },
  { id: "empty-healthcheck-argv", input: { name: "demo", services: { web: { healthcheck: [] } } } },
  { id: "true-healthcheck", input: { name: "demo", services: { web: { healthcheck: true } } } },
  {
    id: "generic-app-mount-type",
    input: { name: "demo", services: { web: { appMount: { target: "/x", type: "bind" } } } },
  },
  {
    id: "generic-app-mount-source",
    input: { name: "demo", services: { web: { appMount: { target: "/x", source: "/host" } } } },
  },
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
  { id: "false-healthcheck", input: { name: "demo", services: { web: { healthcheck: false } } } },
  { id: "string-healthcheck", input: { name: "demo", services: { web: { healthcheck: "pg_isready" } } } },
  { id: "argv-healthcheck", input: { name: "demo", services: { web: { healthcheck: ["pg_isready"] } } } },
  { id: "string-app-mount", input: { name: "demo", services: { web: { appMount: "/site" } } } },
  { id: "false-app-mount", input: { name: "demo", services: { web: { appMount: false } } } },
  {
    id: "unvalidated-app-mount-destination",
    input: { name: "demo", services: { web: { appMount: "disabled" } } },
  },
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
  { suffix: ".lando.stop", reason: "Discovery stop marker, not a Landofile document." },
  { suffix: ".lando.ts", reason: "TypeScript program, not a YAML Landofile document." },
  { suffix: ".lando.base.yml", reason: "Partial base layer, not a canonical Landofile document." },
  { suffix: ".lando.local.yml", reason: "Partial overlay layer, not a canonical Landofile document." },
  { suffix: ".lando.local.ts", reason: "Partial TypeScript overlay layer, not a canonical Landofile document." },
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
    ? issueDetails(validationIssuesFromSchemaIssue(decoded.failure.issue))
    : [];
}

test("runtime JSON Schema agrees with the strict Landofile decoder", async () => {
  // Given all guide/recipe Landofile data plus explicitly invalid boundary inputs.
  // The published 2020-12 document is getJsonSchema("LandofileShape"). The
  // generated snapshot must be that same runtime document.
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

  // When each independent surface receives the same raw parsed data.
  for (const { id, input } of [...fixtures, ...curated, ...curatedValid]) {
    const decoded = Schema.decodeUnknownResult(LandofileShape)(input, parseOptions);
    const accepted = Result.isSuccess(decoded);
    if (curated.some((entry) => entry.id === id)) expect(accepted, id).toBe(false);
    if (curatedValid.some((entry) => entry.id === id)) expect(accepted, id).toBe(true);

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
  expect(paths.length).toBeGreaterThan(0);
});

const INVALID_INPUT_FIXTURES = new Map([
  [
    "router-and-scanner/fixtures/router-and-scanner-invalid",
    "Retries intentionally exceed the allowed range.",
  ],
  ["expressions/fixtures/expressions-plan-time-typed-field", "Planner scopes cannot supply typed values."],
  ["scripting-with-json/fixtures/unknown-service-key", "Deliberate misspelled service property."],
  ["config-translate/fixtures/lando3-compose-arguments", "Legacy Lando 3 source, not v4 input."],
  ["build-steps/fixtures/build-steps-invalid-user", "Deliberately malformed build user."],
  [
    "compose-service-block/fixtures/compose-service-block-rejected",
    "Unsupported Compose service block is deliberately rejected.",
  ],
  ["convert-from-lando-3/fixtures/pantheon-app", "Legacy Pantheon recipe source requires translation."],
  ["convert-from-lando-3/fixtures/lando3-blocked", "Legacy source deliberately blocked by translation."],
  ["convert-from-lando-3/fixtures/lando3-layers", "Legacy layered source requires translation."],
  ["config-lint/fixtures/config-lint-invalid", "Deliberate unknown keys and invalid ports."],
  ["config-lint/fixtures/wrong-type", "Deliberate wrong boolean type for fragment and effective parity."],
  [
    "config-lint/fixtures/wrong-filter-prefix",
    "Deliberate wrong prefix type on a selected route-filter member.",
  ],
  ["config-views/fixtures/invalid", "Deliberate invalid runtime for raw and merged inspection."],
  [
    "your-landofile/fixtures/flow-mapping-rejected",
    "Deliberate populated flow mapping as an environment value.",
  ],
]);

const inputValid = [
  { id: "recipe-boolean", input: { name: "demo", services: { web: { primary: "{{ recipe.flag }}" } } } },
  { id: "env-boolean", input: { name: "demo", services: { web: { primary: "{{ boolean(env.FLAG) }}" } } } },
  { id: "env-number", input: { name: "demo", router: { httpPort: "{{ number(env.PORT) }}" } } },
  { id: "env-number-pipe", input: { name: "demo", router: { httpPort: "{{ env.PORT | number }}" } } },
  { id: "recipe-array", input: { name: "demo", services: { web: { ports: "{{ recipe.ports }}" } } } },
  { id: "recipe-object", input: { name: "demo", router: "{{ recipe.router }}" } },
  { id: "env-object", input: { name: "demo", router: "{{ env.ROUTER | fromJson }}" } },
  { id: "env-array", input: { name: "demo", services: { web: { ports: "{{ env.PORTS | fromJson }}" } } } },
  { id: "recipe-number", input: { name: "demo", router: { httpPort: "{{ recipe.port }}" } } },
  { id: "trim-markers", input: { name: "demo", router: { httpPort: "{{- number(env.PORT) -}}" } } },
  {
    id: "quoted-delimiters",
    input: { name: "demo", services: { web: { primary: '{{ eq("}}", "}}") }}' } } },
  },
  {
    id: "adjacent-object-braces",
    input: { name: "demo", router: { httpPort: "{{ length({a:{b:1}}) }}" } },
  },
] as const;
const inputInvalid = [
  { id: "disabled-tooling-string", input: { tooling: { retired: "disabled" } } },
  { id: "empty-tooling-string", input: { tooling: { retired: "" } } },
  { id: "plain-boolean", input: { name: "demo", services: { web: { primary: "maybe" } } } },
  { id: "plain-number", input: { name: "demo", router: { httpPort: "abc" } } },
  { id: "surrounding-spaces", input: { name: "demo", router: { httpPort: "  {{ number(env.PORT) }}  " } } },
  {
    id: "padded-trim-markers",
    input: { name: "demo", router: { httpPort: "  {{- number(env.PORT) -}}  " } },
  },
  { id: "trailing-newline", input: { name: "demo", router: { httpPort: "{{ number(env.PORT) }}\n" } } },
  { id: "planner-boolean", input: { name: "demo", services: { web: { primary: "{{ app.flag }}" } } } },
  { id: "proxy-boolean", input: { name: "demo", services: { web: { primary: "{{ proxy.flag }}" } } } },
  {
    id: "services-boolean",
    input: { name: "demo", services: { web: { primary: "{{ boolean(services.web.flag) }}" } } },
  },
  { id: "composite-boolean", input: { name: "demo", services: { web: { primary: "x{{ recipe.flag }}" } } } },
  {
    id: "two-boolean-interpolations",
    input: { name: "demo", services: { web: { primary: "{{ recipe.a }}{{ recipe.b }}" } } },
  },
  { id: "static-number-at-text", input: { name: "{{ number(env.PORT) }}" } },
  ...curated.filter(({ id }) =>
    [
      "unknown-top-level",
      "unknown-service-key",
      "wrong-name-type",
      "port-out-of-range",
      "optional-null",
      "reserved-map-key",
    ].includes(id),
  ),
] as const;
const INPUT_INEXPRESSIBLE = new Map([
  [
    "quoted-delimiters",
    "The editor pattern cannot distinguish quoted closing delimiters from an interpolation terminator.",
  ],
  [
    "adjacent-object-braces",
    "The editor pattern treats adjacent object-closing braces as an interpolation terminator; balancing nested objects requires parsing.",
  ],
  [
    "planner-boolean",
    "JSON Schema cannot distinguish scope reads from quoted names without parsing the expression AST.",
  ],
  ["proxy-boolean", "Planner-scope reads require parsed scope analysis."],
  ["services-boolean", "Planner-scope reads nested inside helpers require parsed scope analysis."],
  ["static-number-at-text", "JSON Schema cannot infer helper return types at text sites."],
  [
    "docs/guides/expressions/fixtures/expressions-plan-time-typed-field/.lando.yml",
    "Planner-scope rejection requires parsed scope analysis.",
  ],
]);

test("input Standard Schema and editor JSON Schema accept every classified authoring fixture", async () => {
  const editor = getEditorJsonSchema("LandofileShape");
  const imported = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(editor), {
    patterns: "apply",
    onEnter: importableNode,
  });
  const decode = SchemaParser.decodeUnknownEffect(imported) as (
    input: unknown,
    options?: Parameters<typeof SchemaParser.decodeUnknownEffect>[1],
  ) => Effect.Effect<unknown, SchemaIssue.Issue>;
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
  const observedInvalid = new Set<string>();
  const observedGaps = new Set<string>();
  for (const { id, input } of [...fixtures, ...inputValid, ...curatedValid, ...inputInvalid]) {
    const fixtureException = [...INVALID_INPUT_FIXTURES].find(
      ([path]) => id === `docs/guides/${path}/.lando.yml`,
    );
    const expected = fixtureException === undefined && !inputInvalid.some((entry) => entry.id === id);
    const decoded = Schema.decodeUnknownResult(LandofileAuthoringShape)(input, parseOptions);
    const standard = await LandofileStandardSchema["~standard"].validate(input);
    expect(standard.issues === undefined, id).toBe(Result.isSuccess(decoded));
    expect(issueDetails(standard.issues ?? []), id).toEqual(decoderIssues(decoded));
    expect(standard.issues === undefined, `${id}: ${fixtureException?.[1] ?? "valid authoring input"}`).toBe(
      expected,
    );
    if (fixtureException) observedInvalid.add(fixtureException[0]);
    const jsonAccepted = Exit.isSuccess(Effect.runSyncExit(decode(input, parseOptions)));
    const gap = INPUT_INEXPRESSIBLE.get(id);
    if (gap !== undefined) {
      expect(jsonAccepted, `${id}: ${gap}`).toBe(!expected);
      observedGaps.add(id);
    } else expect(jsonAccepted, id).toBe(expected);
  }
  expect([...observedInvalid].sort()).toEqual([...INVALID_INPUT_FIXTURES.keys()].sort());
  expect([...observedGaps].sort()).toEqual([...INPUT_INEXPRESSIBLE.keys()].sort());
  expect(paths.length).toBeGreaterThan(0);
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
