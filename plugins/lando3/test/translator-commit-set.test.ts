import { expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { completeLando3CommitSet } from "../src/commit-set.ts";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

test.each(["full", "single-layer"] as const)("preserves an empty planned commit set in %s mode", (mode) => {
  // Given
  const recipe = document(".lando.recipe.yml", "{}\n");
  const canonical = document(".lando.yml", "services: {custom: {type: frobnicator}}\n");
  const input = documentSet([recipe, canonical]);
  // When
  const result = completeLando3CommitSet({ ...input, mode }, []);
  // Then
  expect(result).toEqual({ outputs: [], deletions: [] });
});

test("emits no writes or recipe deletion when service lowering produces no output", async () => {
  // Given
  const input = documentSet([
    document(".lando.recipe.yml", "{}\n"),
    document(".lando.yml", "services: {custom: {type: frobnicator}}\n"),
  ]);
  const translator = makeLando3ConfigTranslator({
    decomposers: new Map(),
    redactor: createRedactor("secrets"),
  });
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(result.outputs).toEqual([]);
  expect(result.deletions).toEqual([]);
  expect(result.diagnostics.some(({ kind }) => kind === "unsupported")).toBe(true);
});

test.each(["full", "selected", "unselected"] as const)("recipe deletion intent when %s", async (mode) => {
  // Given
  const recipe = document(".lando.recipe.yml", "{}\n");
  const canonical = document(".lando.yml", "name: app\n");
  const input = documentSet([recipe, canonical]);
  const translator = makeLando3ConfigTranslator({
    decomposers: fakeDecomposers().decomposers,
    redactor: createRedactor("secrets"),
  });
  // When
  const result = await Effect.runPromise(
    translator.translate({
      ...input,
      mode: mode === "full" ? "full" : "single-layer",
      selectedSourceIds: mode === "unselected" ? [canonical.sourceId] : [recipe.sourceId],
    }),
  );
  // Then
  expect(result.deletions.map(({ sourceId }) => sourceId)).toEqual(
    mode === "unselected" ? [] : [recipe.sourceId],
  );
});

test("rewrites a layer when its entire legacy effect is dropped", async () => {
  // Given
  const input = documentSet([
    document(".lando.yml", "name: app\n"),
    document(".lando.local.yml", "excludes: [vendor]\n"),
  ]);
  const translator = makeLando3ConfigTranslator({
    decomposers: new Map(),
    redactor: createRedactor("secrets"),
  });
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(result.outputs.find(({ targetLayer }) => targetLayer === "local")?.fragment).toEqual({});
});
