import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parseLegacyLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";

import type { Lando3Source, Lando3SourceLayer } from "../src/contract.ts";
import { foldToTargetLayers, legacyPrefixViews, requiredOptionViews } from "../src/effective-views.ts";
import { mergedToPlain, toMergedValue } from "../src/legacy-merge.ts";

const source = (layer: Lando3SourceLayer, content: string): Lando3Source => {
  const file = layer === "canonical" ? ".lando.yml" : `.lando.${layer}.yml`;
  const sourceId = ConfigTranslateSourceId.make(file);
  const document = Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
  return { file, sourceId, layer, value: toMergedValue({ document, sourceId, layer }) };
};

const layeredSources = (): ReadonlyArray<Lando3Source> => [
  source("local", "localOnly: true\n"),
  source("recipe", "recipeOnly: true\n"),
  source("base", "name: app\n"),
  source("dist", "recipe: wordpress\nconfig: {redis: true}\n"),
];

describe("effective legacy views", () => {
  test("merges only the prefix through each present layer in ascending order", () => {
    const sources = layeredSources();
    const views = legacyPrefixViews(sources);
    expect(views.map(({ layer }) => layer)).toEqual(["base", "dist", "recipe", "local"]);
    expect(views.map(({ merged }) => mergedToPlain(merged))).toEqual([
      { name: "app" },
      { name: "app", recipe: "wordpress", config: { redis: true } },
      { name: "app", recipe: "wordpress", config: { redis: true }, recipeOnly: true },
      { name: "app", recipe: "wordpress", config: { redis: true }, recipeOnly: true, localOnly: true },
    ]);
    expect(views.map(({ sourceIds }) => sourceIds.map(String))).toEqual([
      [".lando.base.yml"],
      [".lando.base.yml", ".lando.dist.yml"],
      [".lando.base.yml", ".lando.dist.yml", ".lando.recipe.yml"],
      [".lando.base.yml", ".lando.dist.yml", ".lando.recipe.yml", ".lando.local.yml"],
    ]);
    expect(mergedToPlain(views[1]?.recipe)).toBe("wordpress");
    expect(mergedToPlain(views[1]?.config)).toEqual({ redis: true });
  });

  test("folds recipe into dist even when views arrive in reverse order", () => {
    const views = legacyPrefixViews(layeredSources()).toReversed();
    const folded = foldToTargetLayers(views);
    expect(folded.map(({ targetLayer }) => targetLayer)).toEqual(["base", "dist", "local"]);
    expect(folded[1]?.layer).toBe("recipe");
    expect(mergedToPlain(folded[1]?.merged)).toEqual({
      name: "app",
      recipe: "wordpress",
      config: { redis: true },
      recipeOnly: true,
    });
  });

  test("omits absent layers and deduplicates present layers", () => {
    const sources = [source("local", "second: true\n"), source("local", "third: true\n")];
    const views = legacyPrefixViews(sources);
    expect(views.map(({ layer }) => layer)).toEqual(["local"]);
    expect(views[0]?.sourceIds).toEqual(sources.map(({ sourceId }) => sourceId));
    expect(mergedToPlain(views[0]?.merged)).toEqual({ second: true, third: true });
  });

  test("retains changed options but ignores a later name-only change", () => {
    const folded = foldToTargetLayers(
      legacyPrefixViews([
        source("dist", "recipe: wordpress\nconfig: {redis: true}\n"),
        source("local", "config: {redis: false}\n"),
        source("user", "name: renamed\n"),
      ]),
    );
    const required = requiredOptionViews(folded);
    expect(required.map(({ targetLayer }) => targetLayer)).toEqual(["dist", "local"]);
    expect(required.map(({ config }) => mergedToPlain(config))).toEqual([{ redis: true }, { redis: false }]);
  });

  test("drops leading recipe-free views", () => {
    const folded = foldToTargetLayers(
      legacyPrefixViews([source("base", "name: app\n"), source("dist", "recipe: wordpress\n")]),
    );
    const required = requiredOptionViews(folded);
    expect(required.map(({ targetLayer }) => targetLayer)).toEqual(["dist"]);
  });

  test("ignores semantically identical config restatements", () => {
    const folded = foldToTargetLayers(
      legacyPrefixViews([
        source("dist", "recipe: wordpress\nconfig: {redis: true}\n"),
        source("local", "config: {redis: true}\n"),
      ]),
    );
    const required = requiredOptionViews(folded);
    expect(required.map(({ targetLayer }) => targetLayer)).toEqual(["dist"]);
  });

  test("ignores nested tagged spans and object key order but retains changed tags", () => {
    const folded = foldToTargetLayers(
      legacyPrefixViews([
        source("dist", "recipe: wordpress\nconfig: !load {a: [one], b: two}\n"),
        source("local", "config: !load {b: two, a: [one]}\n"),
        source("user", "config: !import {b: two, a: [one]}\n"),
      ]),
    );
    const required = requiredOptionViews(folded);
    expect(required.map(({ targetLayer }) => targetLayer)).toEqual(["dist", "user"]);
  });

  test("retains a recipe-free change after the first recipe", () => {
    const folded = foldToTargetLayers(
      legacyPrefixViews([source("dist", "recipe: wordpress\n"), source("local", "disabled\n")]),
    );
    const required = requiredOptionViews(folded);
    expect(required.map(({ targetLayer }) => targetLayer)).toEqual(["dist", "local"]);
    expect(required[1]?.recipe).toBeUndefined();
    expect(required[1]?.config).toBeUndefined();
  });

  test("returns empty results for empty inputs and recipe-free stacks", () => {
    const folded = foldToTargetLayers(legacyPrefixViews([source("base", "")]));
    expect(legacyPrefixViews([])).toEqual([]);
    expect(foldToTargetLayers([])).toEqual([]);
    expect(requiredOptionViews([])).toEqual([]);
    expect(requiredOptionViews(folded)).toEqual([]);
    expect(folded[0]?.merged).toBeUndefined();
  });

  test("produces deterministic results without reordering its input", () => {
    const sources = layeredSources();
    const views = legacyPrefixViews(sources);
    const folded = foldToTargetLayers(views);
    const required = requiredOptionViews(folded);
    expect(legacyPrefixViews(sources)).toEqual(views);
    expect(foldToTargetLayers(views)).toEqual(folded);
    expect(requiredOptionViews(folded)).toEqual(required);
    expect(sources.map(({ layer }) => layer)).toEqual(["local", "recipe", "base", "dist"]);
  });
});
