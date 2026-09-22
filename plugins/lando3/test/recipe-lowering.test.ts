import { expect, test } from "bun:test";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import type { Lando3SourceLayer } from "../src/contract.ts";
import { foldToTargetLayers, legacyPrefixViews } from "../src/effective-views.ts";
import { toMergedValue } from "../src/legacy-merge.ts";
import { lowerRecipeViews, recipeLayerOutputs } from "../src/recipe-lowering.ts";
import { isPlainRecord, mergeLandofiles } from "../src/v4-merge.ts";
import { document, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

const views = async (entries: ReadonlyArray<readonly [Lando3SourceLayer, string]>) => {
  const sources = await Promise.all(
    entries.map(async ([layer, content]) => {
      const file = `.lando.${layer}.yml`;
      const sourceId = document(file, content).sourceId;
      const parsed = await Effect.runPromise(parseLegacyLandofile({ mode: "legacy", file, content }));
      return { sourceId, layer, file, value: toMergedValue({ document: parsed, sourceId, layer }) };
    }),
  );
  return foldToTargetLayers(legacyPrefixViews(sources));
};

test("preserves layer precedence when an established overlay precedes legacy base conversion", async () => {
  // Given a legacy base and an already converted local overlay sharing a service type.
  const folded = await views([["base", "recipe: lamp\n"]]);
  const base = { services: { appserver: { type: "php", image: "php:8.2" } } };
  const overlay = { services: { appserver: { type: "php", image: "php:8.3" } } };
  // When planning the newly lowered base alongside the established overlay.
  const result = recipeLayerOutputs(
    folded,
    {
      prefixes: [{ targetLayer: "base", sourceIds: [], fragment: base }],
      diagnostics: [],
      decomposeCalls: 1,
    },
    [],
    [{ layer: "local", sourceIds: [], fragment: overlay }],
  );
  // Then the base stands alone and the local overlay wins the final merge.
  expect(result.outputs.map(({ targetLayer, fragment }) => ({ targetLayer, fragment }))).toEqual([
    { targetLayer: "base", fragment: base },
    { targetLayer: "local", fragment: { services: { appserver: { image: "php:8.3" } } } },
  ]);
  expect(mergeLandofiles(result.outputs.map(({ fragment }) => fragment).filter(isPlainRecord))).toEqual(
    overlay,
  );
});

test("decomposes changed options with provenance and only redactor ports", async () => {
  // Given two distinct effective option views.
  const fake = fakeDecomposers();
  const redactor = createRedactor("secrets");
  const folded = await views([
    ["dist", "recipe: wordpress\nconfig: {redis: true}\n"],
    ["local", "config: {redis: false}\n"],
  ]);
  // When lowering without any host IO ports.
  const result = await Effect.runPromise(lowerRecipeViews({ ...fake, redactor }, folded));
  // Then only the pure decomposer ran, once per option set.
  expect(result.decomposeCalls).toBe(2);
  expect(fake.calls.map(({ secrets }) => secrets)).toEqual([{}, {}]);
  expect(fake.receivedPorts).toEqual([{ redactor }, { redactor }]);
  expect(fake.methods).toEqual(["decompose", "decompose"]);
  expect(result.prefixes.map(({ fragment }) => fragment.recipe)).toEqual(
    fake.results.map(({ provenance }) => provenance),
  );
  expect(result.diagnostics.filter(({ kind }) => kind === "generated")).toHaveLength(2);
});

test("does not decompose a name-only later layer", async () => {
  const fake = fakeDecomposers();
  const folded = await views([
    ["dist", "recipe: wordpress\n"],
    ["local", "name: other\n"],
  ]);
  const result = await Effect.runPromise(
    lowerRecipeViews({ ...fake, redactor: createRedactor("secrets") }, folded),
  );
  expect(result.decomposeCalls).toBe(1);
  expect(fake.calls).toHaveLength(1);
});

test.each([
  ["recipe: pantheon\n", "hoster"],
  ["recipe: lamp\nconfig: {php: 7.4}\n", "invalid-option"],
])("fails closed for %s", async (content, reason) => {
  const folded = await views([["dist", content]]);
  const result = await Effect.runPromise(
    Effect.either(lowerRecipeViews({ ...fakeDecomposers(), redactor: createRedactor("secrets") }, folded)),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left")
    expect(result.left.cause).toMatchObject({
      _tag: "Lando3UnsupportedRecipeError",
      reason,
      sourceLayer: "dist",
    });
});

test("reports an unmapped option with its authored span", async () => {
  const folded = await views([["dist", "recipe: wordpress\nconfig: {xdebug: true}\n"]]);
  const result = await Effect.runPromise(
    lowerRecipeViews({ ...fakeDecomposers(), redactor: createRedactor("secrets") }, folded),
  );
  expect(result.diagnostics.find(({ kind }) => kind === "dropped")).toMatchObject({
    keyPath: ["config", "xdebug"],
    span: { start: { line: 2 } },
  });
});
