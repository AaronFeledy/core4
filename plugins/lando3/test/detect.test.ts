import { describe, expect, it } from "bun:test";
import { parseLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId, LandofileAuthoringShape, PortablePath } from "@lando/sdk/schema";
import type { ConfigTranslateDocument } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import {
  LANDO3_TRANSLATOR_ID,
  type Lando3Signal,
  detectLando3,
  lando3Signals,
  sourceLayerForDocument,
} from "../src/detect.ts";

const document = (content: string, source = ".lando.yml"): ConfigTranslateDocument => ({
  sourceId: ConfigTranslateSourceId.make(source),
  layerId: "canonical",
  mediaType: "application/yaml",
  contentDigest: `sha256:${"0".repeat(64)}`,
  bytes: new TextEncoder().encode(content),
});
const detect = (documents: ReadonlyArray<ConfigTranslateDocument>) =>
  Effect.runSync(detectLando3({ documents }));

it("resolves translation layers from filenames before declared layer ids", () => {
  expect(sourceLayerForDocument(document("", "nested/.lando.recipe.yml"))).toBe("recipe");
  expect(sourceLayerForDocument(document("", "C:\\app\\.lando.local.yaml"))).toBe("local");
  expect(sourceLayerForDocument({ ...document("", "opaque-id"), layerId: "dist" })).toBe("dist");
  expect(sourceLayerForDocument({ ...document("", "opaque-id"), layerId: "foreign" })).toBe("canonical");
  expect(
    sourceLayerForDocument({ ...document("", ".lando.recipe.yml"), path: PortablePath.make(".lando.yml") }),
  ).toBe("canonical");
});

const positives: ReadonlyArray<readonly [string, ReadonlyArray<Lando3Signal>]> = [
  ["recipe: drupal10\nconfig: {}", ["recipe-config"]],
  ["services: {web: {api: 3}}", ["service-api-3"]],
  ["services: {web: {api: 3, type: lando, services: {image: nginx}}}", ["service-api-3", "nested-services"]],
  [
    "services: {web: {api: 3, type: compose, services: {image: nginx}}}",
    ["service-api-3", "nested-services"],
  ],
  ["services: {web: {type: lando, services: {image: nginx}}}", ["nested-services"]],
  ["services: {web: {type: compose, services: {image: nginx}}}", ["nested-services"]],
  ["services: {web: {overrides: {}}}", ["service-overrides"]],
  ["services: {web: {build_as_root: []}}", ["build-as-root"]],
  ["services: {web: {run_as_root: []}}", ["run-as-root"]],
  ["services: {web: {build_internal: []}}", ["build-internal"]],
  ["services: {web: {run_internal: []}}", ["run-internal"]],
  ["tooling: {php: {options: {}}}", ["tooling-options"]],
  ["tooling: {install: {cmd: [{web: composer install}, {node: npm install}]}}", ["tooling-service-commands"]],
  ["services: {db: {portforward: false}}", ["service-portforward"]],
  ["proxy: {web: [app.lndo.site]}", ["proxy-string"]],
  ["compose: []", ["compose"]],
  ["pluginDirs: []", ["plugin-dirs"]],
  ["plugins: {}", ["plugins"]],
  ["excludes: []", ["excludes"]],
];

describe("Lando 3 snapshot detection", () => {
  for (const [yaml, signals] of positives) {
    it(`reports exactly ${signals.join(", ")} when given ${yaml}`, () => {
      const input = document(yaml);
      const actual = lando3Signals(input);
      expect(actual).toEqual(signals);
      const weak = ["compose", "plugin-dirs", "plugins", "excludes"];
      expect(detect([input])).toEqual([
        {
          translator: LANDO3_TRANSLATOR_ID,
          sourceIds: [input.sourceId],
          confidence: signals.some((signal) => !weak.includes(signal)) ? "exact" : "likely",
          summary: expect.any(String),
        },
      ]);
      for (const signal of signals) expect(detect([input])[0]?.summary).toContain(signal);
    });
  }

  const negatives = [
    "services: {web: {type: php:8.3}}",
    "services: {web: {api: 4}}",
    "name: valid-v4\nservices: {web: {image: nginx}}",
    "recipe: drupal",
    "config: {}",
    "name: unmarked",
    "runtime: 4",
    'services: {web: {api: "3"}}',
    "services: {web: {api: 4, type: lando, services: {image: nginx}}}",
    "services: {web: {type: php:8.4, services: {image: nginx}}}",
    "services: {web: {type: compose, services: []}}",
    "services: {web: {build: [], run: [], config: {}, plugins: []}}",
    "tooling: {php: {cmd: php}}",
    "tooling: {php: {cmd: []}}",
    "tooling: {php: {cmd: [php, -v]}}",
    "tooling: {php: {cmd: [{web: php, node: node}]}}",
    "tooling: {php: {cmd: [{web: php}, other]}}",
    "tooling: {php: {cmd: [{web: 3}]}}",
    "proxy: {web: [{hostname: app.lndo.site}]}",
    "x-example: {services: {web: {api: 3}}, plugins: {}}",
    "services: {web: false, db: null}\ntooling: {php: false}",
    "tooling: {php: {cmd: !import /does-not-exist/script.sh}}",
    "services: !load /does-not-exist/services.yml",
    "services: {web: !load {api: 3}}",
    "name: [unterminated",
    "plugins: {}\nservices: [unterminated",
  ];
  for (const yaml of negatives) {
    it(`returns no match when given ${yaml}`, () => {
      const input = document(yaml);
      expect(lando3Signals(input)).toEqual([]);
      expect(detect([input])).toEqual([]);
    });
  }

  it("detects the pinned kitchen-sink corpus exactly", async () => {
    const yaml = await Bun.file(new URL("./fixtures/lando3/kitchen-sink.lando.yml", import.meta.url)).text();
    const input = document(yaml);
    expect(detect([input])).toMatchObject([
      { translator: "lando3", confidence: "exact", sourceIds: [input.sourceId] },
    ]);
  });

  for (const name of [".lando.recipe.yml", "nested/.lando.recipe.yml", "C:\\app\\.lando.recipe.yml"]) {
    it(`detects the recipe layer when its fallback filename is ${name}`, () => {
      const input = document("name: innocuous", name);
      expect(lando3Signals(input)).toEqual(["recipe-layer"]);
      expect(detect([document("name: base"), input])).toMatchObject([
        { confidence: "exact", sourceIds: [input.sourceId] },
      ]);
    });
  }
  it("prefers the supplied path over the source identity", () => {
    const recipe = {
      ...document("name: innocuous", "snapshot-1"),
      path: PortablePath.make("dir/.lando.recipe.yml"),
    };
    const ordinary = {
      ...document("name: innocuous", ".lando.recipe.yml"),
      path: PortablePath.make(".lando.yml"),
    };
    expect(detect([ordinary, recipe])).toMatchObject([{ sourceIds: [recipe.sourceId] }]);
  });
  it("does not infer a recipe layer from a parent directory, layer id, or invalid bytes", () => {
    expect(
      detect([
        document("name: app", ".lando.recipe.yml/.lando.yml"),
        { ...document("name: app"), layerId: "recipe" },
        document("name: [broken", ".lando.recipe.yml"),
      ]),
    ).toEqual([]);
  });
  for (const mediaType of ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"]) {
    it(`accepts YAML snapshots with media type ${mediaType}`, () => {
      expect(detect([{ ...document("plugins: {}"), mediaType }])).toMatchObject([{ confidence: "likely" }]);
    });
  }
  for (const mediaType of ["application/json", "text/plain", "application/typescript"]) {
    it(`ignores signals and filenames with media type ${mediaType}`, () => {
      expect(detect([{ ...document("plugins: {}", ".lando.recipe.yml"), mediaType }])).toEqual([]);
    });
  }
  it("uses tagged commands as data without opening their references", () => {
    const input = document(
      "services:\n  web:\n    build_as_root: !load /missing/build.sh\ntooling:\n  test:\n    cmd:\n      - web: !import /missing/test.sh",
    );
    expect(lando3Signals(input)).toEqual(["build-as-root", "tooling-service-commands"]);
  });
  it("preserves input order, ignores failed documents, deduplicates signals, and is deterministic", () => {
    const documents = [
      document("plugins: {}", "z"),
      document("name: app", "a"),
      document("bad: [", "b"),
      document("services: {a: {api: 3}, b: {api: 3}}", "c"),
    ];
    const first = detect(documents);
    expect(first).toEqual(detect(documents));
    expect(first).toMatchObject([
      {
        sourceIds: [ConfigTranslateSourceId.make("z"), ConfigTranslateSourceId.make("c")],
        confidence: "exact",
      },
    ]);
    expect(lando3Signals(documents[3] ?? document(""))).toEqual(["service-api-3"]);
    expect(
      first
        .flatMap((match) => match.sourceIds)
        .every((id) => documents.some((entry) => entry.sourceId === id)),
    ).toBe(true);
  });
  it("returns no match for an empty document set", () => {
    expect(detect([])).toEqual([]);
  });
});

// These recipe READMEs contain CLI examples, not committed scaffold Landofiles.
// Keep realistic authoring snapshots here and schema-check them so a parse failure
// cannot masquerade as successful conservative detection.
for (const [recipe, webroot, database, command] of [
  ["drupal", "/app/web", "mariadb:11.4", "drush status"],
  ["wordpress", "/app", "mariadb:11.4", "wp core version"],
  ["lamp", "/app/public", "mysql:8.0", "php -v"],
  ["lemp", "/app/public", "mariadb:11.4", "composer install"],
] as const) {
  const yaml = `runtime: 4
name: ${recipe}-app
recipe:
  id: ${recipe}
  version: 1.0.0
  producer:
    sourceKind: bundled
    packageName: "@lando/recipes"
    recipeId: ${recipe}
    manifestVersion: 1.0.0
    contentDigest: sha256:${"0".repeat(64)}
  options:
    php: "8.4"
services:
  appserver:
    type: php:8.4
    via: ${recipe === "lemp" ? "fpm" : "apache"}
    webroot: ${webroot}
    routes:
      - hostname: ${recipe}.lndo.site
  database:
    type: ${database}
tooling:
  check:
    service: appserver
    cmd: ${command}
`;
  for (const content of [yaml, yaml.replace("runtime: 4\n", "")]) {
    it(`rejects valid ${recipe} v4 authoring with runtime marker ${content.startsWith("runtime:")}`, () => {
      const parsed = Effect.runSync(parseLandofile({ file: ".lando.yml", cwd: ".", content }));
      Schema.decodeUnknownSync(LandofileAuthoringShape, { onExcessProperty: "error" })(parsed);
      expect(detect([document(content)])).toEqual([]);
    });
  }
}
