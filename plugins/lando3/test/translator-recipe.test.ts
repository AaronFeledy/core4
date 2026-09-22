import { expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { mergeLandofiles } from "../src/v4-merge.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

/**
 * An authoring fragment is a recursive partial whose value sites may also hold
 * expression strings, so narrow one before merging it. A translator output that
 * is not a mapping is a bug, and failing loudly beats widening the type.
 */
const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an authoring mapping, received ${JSON.stringify(value)}.`);
  }
  return Object.fromEntries(Object.entries(value));
};

const setup = (nested = false) => {
  const fake = fakeDecomposers(nested);
  return {
    fake,
    translator: makeLando3ConfigTranslator({
      decomposers: fake.decomposers,
      redactor: createRedactor("secrets"),
    }),
  };
};
const redisDocuments = () => [
  document(".lando.dist.yml", "recipe: wordpress\nconfig: {redis: true}\n"),
  document(".lando.local.yml", "config: {redis: false}\n"),
];

test("removes redis across layers while preserving appserver and final equivalence", async () => {
  const { fake, translator } = setup();
  const result = await Effect.runPromise(translator.translate(documentSet(redisDocuments())));
  expect(result.outputs.find(({ targetLayer }) => targetLayer === "dist")?.fragment).toMatchObject({
    services: { appserver: { image: "php:8.3" } },
  });
  for (const output of result.outputs) expect(output.fragment).not.toHaveProperty("services.redis");
  const relocations = result.diagnostics.filter(({ kind }) => kind === "needs-review");
  expect(relocations).toHaveLength(1);
  expect(relocations[0]?.message).toContain(".lando.dist.yml");
  expect(relocations[0]?.message).toContain(".lando.local.yml");
  expect(relocations[0]?.message).toContain("dist prefix");
  const final = fake.results.at(-1);
  expect(mergeLandofiles(result.outputs.map(({ fragment }) => asRecord(fragment)))).toEqual({
    recipe: final?.provenance,
    ...asRecord(final?.fragment),
  });
});

test("relocates only the nearest nested map and retains its sibling", async () => {
  const { translator } = setup(true);
  const result = await Effect.runPromise(translator.translate(documentSet(redisDocuments())));
  expect(result.outputs.find(({ targetLayer }) => targetLayer === "dist")?.fragment).toMatchObject({
    services: { appserver: { image: "php:8.3" } },
  });
  expect(result.outputs.find(({ targetLayer }) => targetLayer === "dist")?.fragment).not.toHaveProperty(
    "services.appserver.environment",
  );
  expect(result.outputs.find(({ targetLayer }) => targetLayer === "local")?.fragment).toMatchObject({
    services: { appserver: { environment: { KEEP: "yes" } } },
  });
  expect(
    result.diagnostics.filter(({ kind }) => kind === "needs-review").map(({ keyPath }) => keyPath),
  ).toEqual([["services", "appserver", "environment"]]);
});

test("folds the legacy recipe interval into dist", async () => {
  const { fake, translator } = setup();
  const result = await Effect.runPromise(
    translator.translate(
      documentSet([
        document(".lando.dist.yml", "config: {redis: true}\n"),
        document(".lando.recipe.yml", "recipe: wordpress\n"),
      ]),
    ),
  );
  expect(result.outputs.map(({ targetLayer }) => targetLayer)).toEqual(["dist"]);
  expect(result.outputs[0]?.fragment).toEqual({
    recipe: fake.results[0]?.provenance,
    ...asRecord(fake.results[0]?.fragment),
  });
  expect(fake.calls[0]?.options.redis).toBe(true);
});

test("deduplicates dropped config and orders diagnostics by source layer", async () => {
  const { translator } = setup();
  const result = await Effect.runPromise(
    translator.translate(
      documentSet([
        document(".lando.local.yml", "config: {redis: true}\nservices: {}\n"),
        document(".lando.dist.yml", "recipe: wordpress\nconfig: {xdebug: true}\n"),
      ]),
    ),
  );
  const dropped = result.diagnostics.filter(({ kind }) => kind === "dropped");
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toMatchObject({
    keyPath: ["config", "xdebug"],
    span: { start: { line: 2 } },
    remediation: expect.any(String),
  });
  expect(result.diagnostics.findIndex(({ kind }) => kind === "dropped")).toBeLessThan(
    result.diagnostics.findIndex(({ kind }) => kind === "unsupported"),
  );
  expect(
    result.diagnostics.filter(({ kind }) => kind === "unsupported").map(({ keyPath }) => keyPath),
  ).toEqual([["services"]]);
});

test.each(["pantheon", "unknown-id", "drupal9"])(
  "rejects unsupported recipe %s without outputs",
  async (recipe) => {
    const { translator } = setup();
    const result = await Effect.runPromise(
      Effect.either(translator.translate(documentSet([document(".lando.dist.yml", `recipe: ${recipe}\n`)]))),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).not.toHaveProperty("outputs");
  },
);

test.each([false, true])(
  "single-layer conversion requires all hoist layers: writable=%s",
  async (writable) => {
    const { translator } = setup();
    const input = documentSet(redisDocuments());
    const result = await Effect.runPromise(
      Effect.either(
        translator.translate({
          ...input,
          mode: "single-layer",
          selectedSourceIds: [document(".lando.local.yml", "").sourceId],
          writableLayerIds: writable ? ["dist", "local"] : ["local"],
        }),
      ),
    );
    expect(result._tag).toBe(writable ? "Right" : "Left");
    if (result._tag === "Left")
      expect(result.left.remediation).toBe(
        "This layer's conversion also needs edits to dist; run the full conversion instead of --file.",
      );
  },
);

test("emits deterministic outputs and diagnostics", async () => {
  const { translator } = setup();
  const input = documentSet(redisDocuments());
  const first = await Effect.runPromise(translator.translate(input));
  const second = await Effect.runPromise(translator.translate(input));
  expect(second.outputs).toEqual(first.outputs);
  expect(second.diagnostics).toEqual(first.diagnostics);
});

test("rejects a tagged config file instead of lowering defaults", async () => {
  const { translator } = setup();
  const result = await Effect.runPromise(
    Effect.either(
      translator.translate(
        documentSet([document(".lando.yml", "recipe: wordpress\nconfig: !load config.yml\n")]),
      ),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left.message).toBe("config is a tagged file reference and was not read.");
    expect(result.left.remediation).toContain("Inline config");
  }
});

test("single-layer conversion keeps an already lowered recipe and applies a later option", async () => {
  const { fake, translator } = setup();
  const first = await Effect.runPromise(
    translator.translate(documentSet([document(".lando.dist.yml", "name: app\nrecipe: wordpress\n")])),
  );
  const dist = first.outputs.find(({ targetLayer }) => targetLayer === "dist");
  if (dist === undefined) throw new Error("expected dist output");
  const input = documentSet([
    document(
      ".lando.dist.yml",
      'name: app\nrecipe:\n  id: wordpress\n  version: "1.0.0"\n  options:\n    php: "8.3"\n    redis: false\nservices:\n  appserver:\n    image: php:8.3\n',
    ),
    document(".lando.local.yml", "config: {redis: true}\n"),
  ]);
  const result = await Effect.runPromise(
    translator.translate({
      ...input,
      mode: "single-layer",
      selectedSourceIds: [document(".lando.local.yml", "").sourceId],
      writableLayerIds: ["local"],
      currentLowerV4Fragments: [{ layerId: "dist", fragment: dist.fragment }],
    }),
  );
  expect(result.outputs.map(({ targetLayer }) => targetLayer)).toEqual(["local"]);
  const final = fake.results.at(-1);
  expect(
    mergeLandofiles([asRecord(dist.fragment), ...result.outputs.map(({ fragment }) => asRecord(fragment))]),
  ).toEqual({
    name: "app",
    recipe: final?.provenance,
    ...asRecord(final?.fragment),
  });
});

test("single-layer conversion still refuses a hoist into an already lowered layer", async () => {
  const { translator } = setup();
  const first = await Effect.runPromise(
    translator.translate(
      documentSet([document(".lando.dist.yml", "recipe: wordpress\nconfig: {redis: true}\n")]),
    ),
  );
  const dist = first.outputs.find(({ targetLayer }) => targetLayer === "dist");
  if (dist === undefined) throw new Error("expected dist output");
  const input = documentSet([
    document(".lando.dist.yml", "recipe:\n  id: wordpress\n"),
    document(".lando.local.yml", "config: {redis: false}\n"),
  ]);
  const result = await Effect.runPromise(
    Effect.either(
      translator.translate({
        ...input,
        mode: "single-layer",
        selectedSourceIds: [document(".lando.local.yml", "").sourceId],
        writableLayerIds: ["local"],
        currentLowerV4Fragments: [{ layerId: "dist", fragment: dist.fragment }],
      }),
    ),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left.remediation).toContain("dist");
});

test("reports config that has no recipe", async () => {
  const { translator } = setup();
  const result = await Effect.runPromise(
    translator.translate(documentSet([document(".lando.yml", "config: {php: 8.3}\n")])),
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "unsupported",
      keyPath: ["config"],
      message: "config has no Lando 3 recipe to apply to.",
    }),
  );
});

test("single-layer conversion merges established deltas before applying a later option", async () => {
  const { fake, translator } = setup();
  const full = await Effect.runPromise(
    translator.translate(
      documentSet([
        document(".lando.dist.yml", "recipe: wordpress\nconfig: {redis: false}\n"),
        document(".lando.yml", "config: {redis: true}\n"),
      ]),
    ),
  );
  const dist = full.outputs.find(({ targetLayer }) => targetLayer === "dist");
  const canonical = full.outputs.find(({ targetLayer }) => targetLayer === "canonical");
  if (dist === undefined || canonical === undefined) throw new Error("expected dist and canonical outputs");
  const local = document(".lando.local.yml", 'config: {php: "8.2"}\n');
  const input = documentSet([
    document(".lando.dist.yml", "recipe: wordpress\n"),
    document(".lando.yml", "recipe: wordpress\n"),
    local,
  ]);
  const result = await Effect.runPromise(
    translator.translate({
      ...input,
      mode: "single-layer",
      selectedSourceIds: [local.sourceId],
      writableLayerIds: ["local"],
      currentLowerV4Fragments: [
        { layerId: "dist", fragment: dist.fragment },
        { layerId: "canonical", fragment: canonical.fragment },
      ],
    }),
  );
  expect(result.outputs.map(({ targetLayer }) => targetLayer)).toEqual(["local"]);
  expect(fake.calls.at(-1)?.options).toMatchObject({ php: "8.2", redis: true });
  const final = fake.results.at(-1);
  expect(
    mergeLandofiles([
      asRecord(dist.fragment),
      asRecord(canonical.fragment),
      ...result.outputs.map(({ fragment }) => asRecord(fragment)),
    ]),
  ).toEqual({
    recipe: final?.provenance,
    ...asRecord(final?.fragment),
  });
});
