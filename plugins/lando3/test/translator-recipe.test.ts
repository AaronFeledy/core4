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
