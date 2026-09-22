import { describe, expect, test } from "bun:test";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { LegacyOccurrence } from "../src/contract.ts";
import {
  dedupeDiagnostics,
  droppedConfigKey,
  generatedRecipe,
  invalidOptionValue,
  orderDiagnostics,
  relocationDiagnostic,
  unsupportedRecipe,
} from "../src/diagnostics.ts";

const sourceId = ConfigTranslateSourceId.make(".lando.yml");
const occurrence: LegacyOccurrence = {
  sourceId,
  layer: "canonical",
  keyPath: ["original"],
  span: {
    start: { line: 4, column: 3, offset: 20 },
    end: { line: 4, column: 12, offset: 29 },
  },
};
const relocation = {
  unitLabel: "services.redis",
  hoistedTo: "local",
  omittedFrom: ["dist", "canonical"],
  changedPrefixes: ["dist", "canonical"],
  sourceIds: [ConfigTranslateSourceId.make("a"), ConfigTranslateSourceId.make("b")],
  occurrence,
};

describe("recipe diagnostics", () => {
  test("reports a dropped config key", () => {
    const result = droppedConfigKey({ recipeId: "drupal", legacyKey: "xdebug", occurrence });
    expect(result).toEqual({
      kind: "dropped",
      sourceId: ConfigTranslateSourceId.make(".lando.yml"),
      keyPath: ["config", "xdebug"],
      span: { start: { line: 4, column: 3 }, end: { line: 4, column: 12 } },
      message: "config.xdebug has no option on the Lando 4 drupal recipe.",
      remediation: "Set the equivalent value by hand in the generated Landofile after conversion.",
    });
  });

  test("reports an invalid option with allowed values in supplied order", () => {
    const result = invalidOptionValue({
      recipeId: "drupal",
      legacyKey: "php",
      option: "phpVersion",
      allowed: ["8.4", "8.3"],
      occurrence,
    });
    expect(result).toEqual({
      kind: "unsupported",
      sourceId: ConfigTranslateSourceId.make(".lando.yml"),
      keyPath: ["config", "php"],
      span: { start: { line: 4, column: 3 }, end: { line: 4, column: 12 } },
      message:
        "config.php is not a supported value for the Lando 4 drupal recipe option phpVersion. Allowed values: 8.4, 8.3.",
      remediation: "Choose a supported value for phpVersion, or run the app with Lando 3.",
    });
  });

  test("reports a free-form option without an allowed-values list", () => {
    const result = invalidOptionValue({
      recipeId: "drupal",
      legacyKey: "webroot",
      option: "webroot",
      allowed: undefined,
      occurrence,
    });
    expect(result.message).toBe(
      "config.webroot must be a plain string for the Lando 4 drupal recipe option webroot.",
    );
    expect(result.remediation).toBe("Choose a supported value for webroot, or run the app with Lando 3.");
  });

  test("reports an unsupported hosting-provider recipe", () => {
    const result = unsupportedRecipe({ legacyId: "pantheon", reason: "hoster", occurrence });
    expect(result).toEqual({
      kind: "unsupported",
      sourceId: ConfigTranslateSourceId.make(".lando.yml"),
      keyPath: ["recipe"],
      span: { start: { line: 4, column: 3 }, end: { line: 4, column: 12 } },
      message: "recipe pantheon is a hosting-provider recipe with no Lando 4 counterpart.",
      remediation:
        "Run the app with Lando 3 or replace the recipe with explicit v4 services before conversion.",
    });
  });

  test("uses distinct reason messages with identical remediation", () => {
    const reasons = ["hoster", "unknown", "non-string", "no-v4-version"] as const;
    const results = reasons.map((reason) => unsupportedRecipe({ legacyId: "legacy", reason, occurrence }));
    expect(results.map((result) => result.message)).toEqual([
      "recipe legacy is a hosting-provider recipe with no Lando 4 counterpart.",
      "recipe legacy is not a bundled Lando 4 recipe.",
      "recipe must be a plain string id.",
      "recipe legacy targets a major version Lando 4 does not ship.",
    ]);
    for (const result of results) {
      expect(result.remediation).toBe(
        "Run the app with Lando 3 or replace the recipe with explicit v4 services before conversion.",
      );
    }
  });

  test("reports a generated recipe", () => {
    const result = generatedRecipe({ recipeId: "drupal", occurrence });
    expect(result).toEqual({
      kind: "generated",
      sourceId: ConfigTranslateSourceId.make(".lando.yml"),
      keyPath: ["recipe"],
      span: { start: { line: 4, column: 3 }, end: { line: 4, column: 12 } },
      message: "Lando 4 recipe drupal generated this layer from the Lando 3 recipe and config.",
      remediation: "Review the generated services before starting the app.",
    });
  });

  test("reports relocation with every contributing source and changed prefix", () => {
    const result = relocationDiagnostic(relocation);
    expect(result).toEqual({
      kind: "needs-review",
      sourceId: ConfigTranslateSourceId.make(".lando.yml"),
      keyPath: ["services", "redis"],
      span: { start: { line: 4, column: 3 }, end: { line: 4, column: 12 } },
      message:
        "services.redis moved to the local layer because Lando 4 layers cannot remove it later (sources: a, b). The dist, canonical prefix no longer contains services.redis in the translated files.",
      remediation:
        "Review services.redis in the local layer; the earlier layers no longer define it on their own.",
    });
  });

  test("omits the prefix sentence when no prefixes changed", () => {
    const result = relocationDiagnostic({
      ...relocation,
      unitLabel: "routes[name=web]",
      changedPrefixes: [],
    });
    expect(result.message).toBe(
      "routes[name=web] moved to the local layer because Lando 4 layers cannot remove it later (sources: a, b).",
    );
    expect(result.keyPath).toEqual(["routes[name=web]"]);
  });

  test("every constructor supplies remediation and single-line text without a span", () => {
    const unlocated = { ...occurrence, span: undefined };
    const results = [
      droppedConfigKey({ recipeId: "drupal", legacyKey: "xdebug", occurrence: unlocated }),
      invalidOptionValue({
        recipeId: "drupal",
        legacyKey: "php",
        option: "php",
        allowed: [],
        occurrence: unlocated,
      }),
      unsupportedRecipe({ legacyId: "legacy", reason: "unknown", occurrence: unlocated }),
      generatedRecipe({ recipeId: "drupal", occurrence: unlocated }),
      relocationDiagnostic({ ...relocation, occurrence: unlocated }),
    ];
    for (const result of results) {
      expect(result.remediation).toBeDefined();
      expect(result.remediation?.trim().length).toBeGreaterThan(0);
      expect(result.message).not.toMatch(/[\r\n]/u);
      expect(result.span).toBeUndefined();
    }
  });
});

describe("canonical diagnostics", () => {
  test("orders by rank, present span, line, column, path, then original index", () => {
    const a = ConfigTranslateSourceId.make("a");
    const b = ConfigTranslateSourceId.make("b");
    const c = ConfigTranslateSourceId.make("c");
    const diagnostic = (
      message: string,
      fields: Partial<ConfigTranslateDiagnostic>,
    ): ConfigTranslateDiagnostic => ({
      kind: "generated",
      sourceId: b,
      keyPath: ["recipe"],
      message,
      remediation: "Review.",
      ...fields,
    });
    const firstRank = diagnostic("first rank", { sourceId: a });
    const lastRank = diagnostic("last rank", { sourceId: c, span: { start: { line: 1, column: 1 } } });
    const missing = diagnostic("missing span", { keyPath: ["a"] });
    const missingZ = diagnostic("missing span z", { keyPath: ["z"] });
    const earlierLine = diagnostic("earlier line", { span: { start: { line: 1, column: 99 } } });
    const earlierColumn = diagnostic("earlier column", { span: { start: { line: 2, column: 1 } } });
    const pathA = diagnostic("path a", { keyPath: ["config", "a"], span: { start: { line: 2, column: 3 } } });
    const equalFirst = diagnostic("equal first", { span: { start: { line: 2, column: 3 } } });
    const equalSecond = { ...equalFirst, message: "equal second", kind: "unsupported" as const };
    const input = Object.freeze([
      missingZ,
      lastRank,
      equalFirst,
      earlierColumn,
      missing,
      equalSecond,
      pathA,
      firstRank,
      earlierLine,
    ]);
    const ranks = new Map([
      [a, 0],
      [b, 1],
      [c, 2],
    ]);
    const result = orderDiagnostics(input, (id) => ranks.get(id) ?? 3);
    expect(result).toEqual([
      firstRank,
      earlierLine,
      earlierColumn,
      pathA,
      equalFirst,
      equalSecond,
      missing,
      missingZ,
      lastRank,
    ]);
  });

  test("deduplicates exact identity tuples while retaining the first and different kinds", () => {
    const first = generatedRecipe({ recipeId: "drupal", occurrence });
    const duplicate = { ...first, message: "Later message", span: undefined };
    const otherKind = { ...first, kind: "unsupported" as const };
    const otherSource = { ...first, sourceId: ConfigTranslateSourceId.make("other") };
    const dotted = { ...first, keyPath: ["a.b"] };
    const nested = { ...first, keyPath: ["a", "b"] };
    const numeric = { ...first, keyPath: [1] };
    const string = { ...first, keyPath: ["1"] };
    const result = dedupeDiagnostics(
      Object.freeze([first, duplicate, otherKind, otherSource, dotted, nested, numeric, string]),
    );
    expect(result).toEqual([first, otherKind, otherSource, dotted, nested, numeric, string]);
    expect(result[0]).toBe(first);
  });
});
