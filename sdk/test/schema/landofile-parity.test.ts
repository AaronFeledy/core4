import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { BuildBlock, RecipeManifest, getJsonSchema } from "@lando/sdk/schema";
import { LandofileStandardSchema, RecipeManifestStandardSchema } from "@lando/sdk/schema/standard";
import { Arbitrary, Effect, Result, Schema } from "effect";
import { expectInvalidReason } from "../../../scripts/guides/fixture-marker.ts";
import { EnvironmentAssignment } from "../../src/schema/environment-input.ts";
import {
  authoringVerdicts,
  decodeAuthoring,
  decoderIssues,
  issueDetails,
  landofileParityValidators,
  parseOptions,
  runtimeOnlyAuthoring,
  runtimeVerdicts,
  serviceWith,
  uniformAuthoring,
} from "./landofile-parity-harness.ts";
import { publicationCases } from "./landofile-parity-mutations.ts";

const root = new URL("../../../", import.meta.url);

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invalidServiceKeys = [
  { id: "service-label-too-long", input: { name: "demo", services: { ["a".repeat(64)]: {} } } },
  {
    id: "service-name-too-long",
    input: {
      name: "demo",
      services: { [["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join(".")]: {} },
    },
  },
  { id: "service-key-with-slash", input: { name: "demo", services: { "bad/name": {} } } },
] as const;

const curated = [
  ...invalidServiceKeys,
  {
    id: "bad-service-key-and-bodies",
    input: { name: "demo", services: { "bad/name": { image: 5 }, web: { primary: "maybe" } } },
  },
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
  {
    id: "dns-service-keys",
    input: { name: "demo", services: { pma_theme: {}, "8.3": {}, ["a".repeat(63)]: {} } },
  },
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

const GAP_CLASS = {
  "empty-healthcheck-argv": "empty-array:services.*.healthcheck",
  "compose-port-out-of-range": "out-of-range:services.*.ports[]",
  "invalid-semver-range": "invalid-range:lando",
  "docs/guides/schedule/fixtures/schedule-rejected-every/.lando.yml": "invalid-interval:services.*.schedule",
  "docs/guides/expressions/fixtures/expressions-plan-time-typed-field/.lando.yml":
    "expression-scope:typed-field",
  "docs/guides/expressions/fixtures/expressions-service-port-misuse/.lando.yml":
    "expression-scope:service-field",
  "notice-removal-not-after-since": "version-order:tooling.*.deprecated",
  "planner-boolean": "expression-scope:services.*.primary",
  "proxy-boolean": "expression-scope:services.*.primary",
  "services-boolean": "expression-scope:services.*.primary",
  "static-number-at-text": "expression-helper-type:name",
  "quoted-delimiters": "expression-quotes:typed-field",
  "adjacent-object-braces": "expression-object-braces:typed-field",
} as const;

type GapCase = keyof typeof GAP_CLASS;
const gapReason = (gaps: ReadonlyMap<string, string>, id: string) => {
  const reason = gaps.get(id);
  if (reason === undefined) return undefined;
  return `${GAP_CLASS[id as GapCase]}: ${reason}`;
};

/** Decoder rejects; every published authoring document still accepts. */
const AUTHORING_PUBLISHED_GAPS = new Map<string, string>([
  [
    "empty-healthcheck-argv",
    "Empty healthcheck argv is a decoder filter; JSON Schema permits an empty array arm.",
  ],
  [
    "compose-port-out-of-range",
    "Compose port normalization range is a decoder transform after JSON Schema projection.",
  ],
  ["invalid-semver-range", "The lando string uses semver.validRange, which has no JSON Schema projection."],
  [
    "docs/guides/schedule/fixtures/schedule-rejected-every/.lando.yml",
    "Clock-aligned @every steps and five-field cron are decoder filters the editor schema cannot express.",
  ],
  [
    "docs/guides/expressions/fixtures/expressions-plan-time-typed-field/.lando.yml",
    "Planner-scope rejection requires parsed scope analysis.",
  ],
  [
    "docs/guides/expressions/fixtures/expressions-service-port-misuse/.lando.yml",
    "Self-port scope admission requires parsed member and destination checks.",
  ],
  ["notice-removal-not-after-since", "JSON Schema cannot compare the removeIn and since versions."],
  [
    "planner-boolean",
    "JSON Schema cannot distinguish scope reads from quoted names without parsing the expression AST.",
  ],
  ["proxy-boolean", "Planner-scope reads require parsed scope analysis."],
  ["services-boolean", "Planner-scope reads nested inside helpers require parsed scope analysis."],
  ["static-number-at-text", "JSON Schema cannot infer helper return types at text sites."],
]);

/** Decoder accepts; published authoring documents reject (pattern over-rejection). */
const AUTHORING_PATTERN_OVERREJECT = new Map<string, string>([
  [
    "quoted-delimiters",
    "The editor pattern cannot distinguish quoted closing delimiters from an interpolation terminator.",
  ],
  [
    "adjacent-object-braces",
    "The editor pattern treats adjacent object-closing braces as an interpolation terminator; balancing nested objects requires parsing.",
  ],
]);

/** Runtime decoder rejects; runtime JSON Schema accepts. */
const RUNTIME_PUBLISHED_GAPS = new Map<string, string>([
  [
    "compose-port-out-of-range",
    "Compose port normalization range is a decoder transform after JSON Schema projection.",
  ],
  ["invalid-semver-range", "The lando string uses semver.validRange, which has no JSON Schema projection."],
  [
    "docs/guides/schedule/fixtures/schedule-rejected-every/.lando.yml",
    "Clock-aligned @every steps and five-field cron are decoder filters; JSON Schema cannot express either rule.",
  ],
  ["notice-removal-not-after-since", "JSON Schema cannot compare the removeIn and since versions."],
]);

const SKIPPED = [
  { suffix: ".lando.stop", reason: "Discovery stop marker, not a Landofile document." },
  { suffix: ".lando.ts", reason: "TypeScript program, not a YAML Landofile document." },
  {
    suffix: ".lando.local.ts",
    reason: "TypeScript overlay program, not a canonical YAML Landofile document.",
  },
  { suffix: ".lando.base.yml", reason: "Partial base layer, not a canonical Landofile document." },
  { suffix: ".lando.local.yml", reason: "Partial overlay layer, not a canonical Landofile document." },
  { suffix: ".lando.recipe.yml", reason: "Recipe overlay layer, not a canonical Landofile document." },
  { suffix: ".lando.tasks.yml", reason: "Tooling include fragment, not a canonical Landofile document." },
] as const;

const inputValid = [
  {
    id: "endpoint-item-expressions",
    input: {
      name: "demo",
      services: { web: { endpoints: ["{{ env.EP }}", "http:{{ env.PORT }}", "${EP}"] } },
    },
  },
  {
    id: "endpoint-list-expression",
    input: { name: "demo", services: { web: { endpoints: "{{ [env.EP] }}" } } },
  },
  {
    id: "notice-field-expression",
    input: {
      name: "demo",
      tooling: {
        old: {
          cmd: "echo",
          deprecated: { since: "4.2.0", severity: "{{ env.SEVERITY }}", note: "Use new." },
        },
      },
    },
  },
  {
    id: "app-versioned-notice",
    input: {
      name: "demo",
      tooling: { old: { cmd: "echo", deprecated: { since: "1.2.0", note: "Use new." } } },
    },
  },
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
  ...invalidServiceKeys,
  {
    id: "bad-service-key-and-bodies",
    input: { name: "demo", services: { "bad/name": { image: 5 }, web: { primary: "maybe" } } },
  },
  {
    id: "notice-removal-not-after-since",
    input: {
      name: "demo",
      tooling: {
        old: { cmd: "echo", deprecated: { since: "4.2.0", removeIn: "4.2.0", note: "Use new." } },
      },
    },
  },
  { id: "disabled-tooling-string", input: { tooling: { retired: "disabled" } } },
  { id: "empty-tooling-string", input: { tooling: { retired: "" } } },
  { id: "plain-boolean", input: { name: "demo", services: { web: { primary: "maybe" } } } },
  { id: "plain-number", input: { name: "demo", router: { httpPort: "abc" } } },
  {
    id: "surrounding-spaces",
    input: { name: "demo", router: { httpPort: "  {{ number(env.PORT) }}  " } },
  },
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
  {
    id: "composite-boolean",
    input: { name: "demo", services: { web: { primary: "x{{ recipe.flag }}" } } },
  },
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

const structuralFixtureOverrides = new Map([
  ["docs/guides/expressions/fixtures/expressions-typed-values/.lando.yml", false],
  ["docs/guides/config-views/fixtures/layered/.lando.yml", false],
  ["docs/guides/expressions/fixtures/expressions-service-port-misuse/.lando.yml", true],
]);

async function loadCorpus() {
  const paths = [
    ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.yml").scanSync({
      cwd: fileURLToPath(root),
      dot: true,
    }),
    ...new Bun.Glob("recipes/**/.lando.yml").scanSync({ cwd: fileURLToPath(root), dot: true }),
  ].sort();
  const fixtures = await Promise.all(
    paths.map(async (id) => {
      const content = await Bun.file(new URL(id, root)).text();
      const authoring = expectInvalidReason(content) === undefined;
      return {
        id,
        input: Bun.YAML.parse(content),
        authoring,
        runtime: structuralFixtureOverrides.get(id) ?? authoring,
      };
    }),
  );
  return { paths, fixtures };
}

function expectAuthoringStages(
  id: string,
  actual: Awaited<ReturnType<typeof authoringVerdicts>>,
  decodedAccept: boolean,
) {
  const overreject = gapReason(AUTHORING_PATTERN_OVERREJECT, id);
  const publishedGap = gapReason(AUTHORING_PUBLISHED_GAPS, id);
  if (overreject !== undefined) {
    expect(decodedAccept, `${id}: decoder accepts (${overreject})`).toBe(true);
    expect(actual, id).toEqual({
      decode: true,
      standard: true,
      editor: false,
      standard07: false,
      standard2020: false,
      authoring: false,
    });
    return "overreject" as const;
  }
  if (publishedGap !== undefined) {
    expect(decodedAccept, `${id}: decoder rejects (${publishedGap})`).toBe(false);
    expect(actual, id).toEqual(runtimeOnlyAuthoring);
    return "published-gap" as const;
  }
  expect(actual, id).toEqual(uniformAuthoring(decodedAccept));
  return "agree" as const;
}

function expectRuntimeStages(id: string, actual: ReturnType<typeof runtimeVerdicts>, decodedAccept: boolean) {
  const gap = gapReason(RUNTIME_PUBLISHED_GAPS, id);
  if (gap !== undefined) {
    expect(decodedAccept, `${id}: runtime decoder rejects (${gap})`).toBe(false);
    expect(actual, id).toEqual({ decode: false, runtime: true });
    return "published-gap" as const;
  }
  expect(actual, id).toEqual({ decode: decodedAccept, runtime: decodedAccept });
  return "agree" as const;
}

function gapIdsObservedIn(ids: ReadonlySet<string>, maps: ReadonlyArray<Map<string, string>>) {
  return [...new Set(maps.flatMap((map) => [...map.keys()]))].filter((id) => ids.has(id)).sort();
}

test("published runtime JSON Schema document is the LandofileShape snapshot", async () => {
  const generated = getJsonSchema("LandofileShape");
  const snapshot = JSON.parse(
    await Bun.file(new URL("../../../dist/schemas/landofile-shape.json", import.meta.url)).text(),
  );
  expect(isJsonSchema(generated)).toBe(true);
  if (!isJsonSchema(generated)) return;
  expect(generated.$schema).toBe(DRAFT_2020_12);
  expect(snapshot).toEqual(generated);
});

test("corpus and curated inputs carry explicit per-stage Landofile verdicts", async () => {
  landofileParityValidators();
  const { paths, fixtures } = await loadCorpus();
  const observedAuthoringGaps = new Set<string>();
  const observedRuntimeGaps = new Set<string>();
  const seen = new Set<string>();

  for (const { id, input, authoring, runtime } of [
    ...fixtures,
    ...curated.map((entry) => ({ ...entry, authoring: false, runtime: false })),
    ...curatedValid.map((entry) => ({ ...entry, authoring: true, runtime: true })),
    ...inputValid.map((entry) => ({ ...entry, authoring: true, runtime: undefined })),
    ...inputInvalid.map((entry) => ({
      ...entry,
      authoring: false,
      runtime: entry.id === "notice-removal-not-after-since" ? false : undefined,
    })),
  ]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const authoringKind = expectAuthoringStages(id, await authoringVerdicts(input), authoring);
    if (authoringKind !== "agree") observedAuthoringGaps.add(id);

    if (runtime !== undefined && expectRuntimeStages(id, runtimeVerdicts(input), runtime) !== "agree") {
      observedRuntimeGaps.add(id);
    }

    const decoded = decodeAuthoring(input, parseOptions);
    const standard = await LandofileStandardSchema["~standard"].validate(input);
    expect(standard.issues === undefined, id).toBe(Result.isSuccess(decoded));
    expect(issueDetails(standard.issues ?? []), id).toEqual(decoderIssues(decoded, input));
    if (id === "bad-service-key-and-bodies") {
      expect(decoderIssues(decoded, input).map(({ path }) => path)).toEqual([
        ["services", "bad/name"],
        ["services", "bad/name", "image"],
        ["services", "web", "primary"],
      ]);
    }
  }

  expect([...observedAuthoringGaps].sort()).toEqual(
    gapIdsObservedIn(seen, [AUTHORING_PUBLISHED_GAPS, AUTHORING_PATTERN_OVERREJECT]),
  );
  expect([...observedRuntimeGaps].sort()).toEqual(gapIdsObservedIn(seen, [RUNTIME_PUBLISHED_GAPS]));
  expect(paths.length).toBeGreaterThan(0);
});

test.each([...publicationCases])(
  "mutation $kind/$id carries explicit per-stage verdicts",
  async ({ id, input, authoring, runtime }) => {
    landofileParityValidators();
    expect(await authoringVerdicts(input), id).toEqual(uniformAuthoring(authoring));
    expect(runtimeVerdicts(input), id).toEqual({ decode: runtime, runtime });
  },
);

test("Arbitrary constructive environment leaves agree across stages", async () => {
  landofileParityValidators();
  const samples = await Effect.runPromise(
    Arbitrary.sampleEffect(Arbitrary.schema(EnvironmentAssignment), {
      seed: 2199,
      count: 16,
      maxDiscards: 1024,
    }),
  );
  expect(samples.length).toBe(16);
  for (const sample of samples) {
    const input = serviceWith({ environment: [sample] });
    expect(await authoringVerdicts(input), JSON.stringify(sample)).toEqual(uniformAuthoring(true));
    expect(runtimeVerdicts(input), JSON.stringify(sample)).toEqual({ decode: true, runtime: true });
  }
});

test("Arbitrary build leaves agree across authoring and runtime stages", async () => {
  landofileParityValidators();
  const leaf = Schema.Struct({ build: Schema.toEncoded(BuildBlock) });
  const samples = await Effect.runPromise(
    Arbitrary.sampleEffect(Arbitrary.schema(leaf), { seed: 2199, count: 24 }),
  );
  expect(samples.length).toBe(24);
  for (const sample of samples) {
    const input = serviceWith(sample);
    expect(await authoringVerdicts(input), JSON.stringify(sample)).toEqual(uniformAuthoring(true));
    expect(runtimeVerdicts(input), JSON.stringify(sample)).toEqual({ decode: true, runtime: true });
  }
});

test("skips non-Landofile fixture files only when a reason is listed", () => {
  const discovered = [
    ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.*").scanSync({
      cwd: fileURLToPath(root),
      dot: true,
    }),
    ...new Bun.Glob("recipes/**/.lando.*").scanSync({ cwd: fileURLToPath(root), dot: true }),
  ];
  const skipped = discovered.filter((path) => !path.endsWith(".lando.yml"));
  const unclassified = skipped.filter((path) => !SKIPPED.some((entry) => path.endsWith(entry.suffix)));
  expect(unclassified).toEqual([]);
  for (const entry of SKIPPED)
    expect(
      skipped.some((path) => path.endsWith(entry.suffix)),
      entry.reason,
    ).toBe(true);
  console.info(`Landofile parity skipped: ${skipped.length}`);
});

test("compiled recipe manifests agree with RecipeManifest", async () => {
  const manifest = Result.getOrThrow(
    compileRecipeSource(
      {
        id: "parity",
        title: "Parity",
        description: "Compiled recipe contract fixture",
        version: "1.0.0",
        options: { enabled: { type: { kind: "boolean" }, default: false, prompt: {} } },
        config: { runtime: 4 },
      },
      { sourceKind: "bundled", packageName: "@lando/recipe-parity", assets: [] },
    ),
  );
  const fixtures = [
    { id: "compiled", input: manifest, accepted: true },
    { id: "invalid-title", input: { ...manifest, title: 7 }, accepted: false },
    { id: "excess-property", input: { ...manifest, unexpected: true }, accepted: false },
  ];
  for (const { id, input, accepted } of fixtures) {
    const decoded = Schema.decodeUnknownResult(RecipeManifest)(input, parseOptions);
    const standard = await RecipeManifestStandardSchema["~standard"].validate(input);
    expect(Result.isSuccess(decoded), id).toBe(accepted);
    expect(standard.issues === undefined, id).toBe(accepted);
    expect(issueDetails(standard.issues ?? []), id).toEqual(decoderIssues(decoded, input));
  }
});
