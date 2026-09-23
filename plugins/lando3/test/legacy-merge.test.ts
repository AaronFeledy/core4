/** Regression coverage for foreign merging against real legacy YAML documents. */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { isLegacyTagged, parseLegacyLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";

import type { Lando3Source, Lando3SourceLayer } from "../src/contract.ts";
import { mergeLegacySources, mergedToPlain, occurrencesAt, toMergedValue } from "../src/legacy-merge.ts";
import { indexLegacySpans, lookupIdentityName, lookupSpan } from "../src/source.ts";

const source = (layer: Lando3SourceLayer, content: string): Lando3Source => {
  const file = layer === "canonical" ? ".lando.yml" : `.lando.${layer}.yml`;
  const sourceId = ConfigTranslateSourceId.make(file);
  const document = Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
  return { file, sourceId, layer, value: toMergedValue({ document, sourceId, layer }) };
};

describe("legacy foreign merge", () => {
  test("deep merges mappings in layer order, replacing scalars and mappings", () => {
    const sources = [
      source("local", "services: {web: {port: 8080}, db: disabled}\nname: local\n"),
      source("canonical", "services: {web: {port: 80, type: php}, db: {type: mysql}}\nname: app\n"),
    ];
    const result = mergeLegacySources(sources);
    expect(mergedToPlain(result)).toEqual({
      services: { web: { port: 8080, type: "php" }, db: "disabled" },
      name: "local",
    });
  });

  test("concatenates earlier items first and deduplicates primitives", () => {
    const result = mergeLegacySources([
      source("canonical", "items: [a, 1, true, null]\n"),
      source("local", "items: [1, b, null, true, a]\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ items: ["a", 1, true, null, "b"] });
  });

  test("keeps structurally equal objects and arrays with distinct identities", () => {
    const result = mergeLegacySources([
      source("canonical", "items: [{x: 1}, [a]]\n"),
      source("local", "items: [{x: 1}, [a]]\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ items: [{ x: 1 }, ["a"], { x: 1 }, ["a"]] });
  });

  test("keeps repeated aliases until a later array is merged", () => {
    const alone = mergeLegacySources([source("canonical", "items: [&same {x: 1}, *same, *same]\n")]);
    expect(mergedToPlain(alone)).toEqual({ items: [{ x: 1 }, { x: 1 }, { x: 1 }] });
    const merged = mergeLegacySources([
      source("canonical", "items: [&same {x: 1}, *same, *same]\n"),
      source("local", "items: [extra]\n"),
    ]);
    expect(mergedToPlain(merged)).toEqual({ items: [{ x: 1 }, "extra"] });
    expect(occurrencesAt(merged, ["items", 0]).map(({ keyPath }) => keyPath)).toEqual([
      ["items", 0],
      ["items", 1],
      ["items", 2],
    ]);
  });

  test("keeps repeated primitives in one document", () => {
    expect(mergedToPlain(mergeLegacySources([source("canonical", "items: [a, a]\n")]))).toEqual({
      items: ["a", "a"],
    });
  });

  test("scopes anchor identity to the source document", () => {
    const result = mergeLegacySources([
      source("canonical", "items: [&same {x: 1}, *same]\n"),
      source("local", "items: [&same {x: 1}, *same]\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ items: [{ x: 1 }, { x: 1 }] });
  });

  test("uses SameValueZero for YAML NaN and signed zero", () => {
    const result = mergeLegacySources([
      source("canonical", "items: [.nan, -0]\n"),
      source("local", "items: [.NaN, 0]\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ items: [Number.NaN, 0] });
  });

  test("cannot remove earlier array items with an empty later array", () => {
    const result = mergeLegacySources([
      source("canonical", "items: [keep]\n"),
      source("local", "items: []\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ items: ["keep"] });
  });

  test("appends a non-array source to an existing array", () => {
    const result = mergeLegacySources([
      source("canonical", "items: [keep]\n"),
      source("local", "items: null\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ items: ["keep", null] });
  });

  test("null overwrites a scalar while an absent key preserves it", () => {
    const result = mergeLegacySources([
      source("canonical", "replace: old\nkeep: old\n"),
      source("local", "replace: null\n"),
    ]);
    expect(mergedToPlain(result)).toEqual({ replace: null, keep: "old" });
  });

  test("empty documents do not overwrite and an empty source set stays empty", () => {
    const empty = source("local", "");
    expect(empty.value).toBeUndefined();
    expect(mergedToPlain(mergeLegacySources([source("canonical", "name: app\n"), empty]))).toEqual({
      name: "app",
    });
    expect(mergeLegacySources([])).toBeUndefined();
  });

  test("retains scalar history oldest first and names the latest winner", () => {
    const result = mergeLegacySources([
      source("canonical", "name: canonical\n"),
      source("local", "name: local\n"),
      source("base", "name: base\n"),
    ]);
    expect(occurrencesAt(result, ["name"]).map(({ sourceId }) => String(sourceId))).toEqual([
      ".lando.base.yml",
      ".lando.yml",
      ".lando.local.yml",
    ]);
  });

  test("retains both sources and authored spans on a deduplicated item", () => {
    const result = mergeLegacySources([
      source("canonical", "name: app\nitems:\n  - shared\n"),
      source("local", "items: [shared]\n"),
    ]);
    const occurrences = occurrencesAt(result, ["items", 0]);
    expect(occurrences.map(({ sourceId }) => String(sourceId))).toEqual([".lando.yml", ".lando.local.yml"]);
    expect(occurrences[0]?.span?.start.line).toBe(3);
    expect(occurrencesAt(result, ["missing"])).toEqual([]);
  });

  test("preserves tagged markers without reading their referenced files", () => {
    const result = mergeLegacySources([
      source("canonical", "!load ./absent.sh\n"),
      source("local", "!import ./other-absent.yml\n"),
    ]);
    const plain = mergedToPlain(result);
    expect(isLegacyTagged(plain)).toBe(true);
    if (!isLegacyTagged(plain)) return;
    expect(plain.tag).toBe("!import");
    expect(plain.value).toBe("./other-absent.yml");
    expect(plain.span.start.line).toBe(1);
    expect(occurrencesAt(result, []).map(({ layer }) => layer)).toEqual(["canonical", "local"]);
  });

  test("indexes exact identity paths without inheriting aliases into descendants", () => {
    const document = Effect.runSync(
      parseLegacyLandofile({
        mode: "legacy",
        file: ".lando.yml",
        content: "original: &a {x: 1}\ncopy: *a\nmerged: {<<: *a}\n",
      }),
    );
    const index = indexLegacySpans(document.root);
    expect(lookupIdentityName(index, ["original"])).toBe("a");
    expect(lookupIdentityName(index, ["copy"])).toBe("a");
    expect(lookupIdentityName(index, ["copy", "x"])).toBeUndefined();
    expect(lookupIdentityName(index, ["merged", "<<"])).toBeUndefined();
    expect(lookupSpan(index, ["copy", "x"])?.start.line).toBe(2);
  });

  test("merges the same sources deterministically without mutating them", () => {
    const sources = [source("canonical", "items: [a, {x: 1}]\n"), source("local", "items: [a, {x: 1}]\n")];
    const result = mergeLegacySources(sources);
    expect(mergeLegacySources(sources)).toEqual(result);
    expect(mergedToPlain(sources[0]?.value)).toEqual({ items: ["a", { x: 1 }] });
  });
});
