import { describe, expect, test } from "bun:test";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { Lando3Source, Lando3SourceLayer } from "../src/contract.ts";
import { occurrencesAt, toMergedValue } from "../src/legacy-merge.ts";
import {
  BUNDLED_RECIPE_OPTION_MAPS,
  HOSTER_RECIPE_IDS,
  LEGACY_RECIPE_ALIASES,
  PHP_VERSIONS,
  classifyRecipe,
  mapConfigOptions,
} from "../src/recipe-options.ts";

const source = (layer: Lando3SourceLayer, content: string): Lando3Source => {
  const file = layer === "canonical" ? ".lando.yml" : `.lando.${layer}.yml`;
  const sourceId = ConfigTranslateSourceId.make(file);
  const document = Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
  return { file, sourceId, layer, value: toMergedValue({ document, sourceId, layer }) };
};
const entries = (content: string) => {
  const root = source("canonical", content).value;
  if (root?.kind !== "mapping") throw new Error("Expected fixture mapping");
  return root.entries;
};
const mapped = (content: string) => {
  const values = entries(content);
  const classification = classifyRecipe(values.get("recipe"));
  if (classification?._tag !== "supported") throw new Error("Expected supported fixture recipe");
  const result = mapConfigOptions(classification, values.get("config"));
  for (const entry of [...result.dropped, ...result.invalid]) {
    expect(entry.occurrences.length).toBeGreaterThan(0);
    expect(entry.occurrences.some(({ span }) => span !== undefined)).toBe(true);
    expect(entry.occurrences).toEqual(occurrencesAt(values.get("config"), [entry.legacyKey]));
  }
  return result;
};

describe("published recipe option tables", () => {
  test("contains exactly the closed catalog, aliases and hosters", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.size).toBe(9);
    expect(PHP_VERSIONS).toEqual(["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"]);
    expect([...HOSTER_RECIPE_IDS]).toEqual(["pantheon", "platformsh", "lagoon", "acquia"]);
    expect([...LEGACY_RECIPE_ALIASES]).toEqual([
      ["drupal10", { recipeId: "drupal", pinned: { drupal: "10" } }],
      ["drupal11", { recipeId: "drupal", pinned: { drupal: "11" } }],
    ]);
  });
  test("matches drupal", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get("drupal")).toEqual({
      recipeId: "drupal",
      options: {
        drupal: { kind: "enum", values: ["11", "10"] },
        php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
        webserver: { kind: "enum", values: ["apache", "nginx"] },
        database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0", "postgres:16"] },
        composer: { kind: "enum", values: ["2", "2.7.7"] },
        webroot: { kind: "string" },
      },
      defaults: {
        drupal: "11",
        php: "8.3",
        webserver: "apache",
        database: "mariadb:11.4",
        composer: "2",
        webroot: "/app/web",
      },
      renames: { composer_version: "composer", via: "webserver" },
    });
  });
  test("matches wordpress", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get("wordpress")).toEqual({
      recipeId: "wordpress",
      options: { php: { kind: "enum", values: ["8.2", "8.3"] }, redis: { kind: "boolean" } },
      defaults: { php: "8.3", redis: false },
      renames: { composer_version: "composer" },
    });
  });
  test.each(["lamp", "backdrop", "joomla"])("matches %s", (recipeId) => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get(recipeId)).toEqual({
      recipeId,
      options: {
        php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
        database: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0"] },
        composer: { kind: "enum", values: ["2", "2.7.7", "false"] },
        webroot: { kind: "string" },
      },
      defaults: { php: "8.3", database: "mariadb:11.4", composer: "2", webroot: "/app" },
      renames: { composer_version: "composer" },
    });
  });
  test("matches lemp", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get("lemp")).toEqual({
      recipeId: "lemp",
      options: { php: { kind: "enum", values: ["8.2", "8.3"] } },
      defaults: { php: "8.3" },
      renames: { composer_version: "composer" },
    });
  });
  test("matches laravel", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get("laravel")).toEqual({
      recipeId: "laravel",
      options: {
        php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
        database: { kind: "enum", values: ["mariadb:11.4", "postgres:16"] },
        composer: { kind: "enum", values: ["2", "2.7.7"] },
        webroot: { kind: "string" },
        worker: { kind: "boolean" },
      },
      defaults: {
        php: "8.3",
        database: "mariadb:11.4",
        composer: "2",
        webroot: "/app/public",
        worker: false,
      },
      renames: { composer_version: "composer" },
    });
  });
  test("matches symfony", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get("symfony")).toEqual({
      recipeId: "symfony",
      options: {
        php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
        database: { kind: "enum", values: ["postgres:16", "mariadb:11.4"] },
        composer: { kind: "enum", values: ["2", "2.7.7"] },
        webroot: { kind: "string" },
      },
      defaults: { php: "8.3", database: "postgres:16", composer: "2", webroot: "/app/public" },
      renames: { composer_version: "composer" },
    });
  });
  test("matches mean", () => {
    expect(BUNDLED_RECIPE_OPTION_MAPS.get("mean")).toEqual({
      recipeId: "mean",
      options: { node: { kind: "enum", values: ["lts", "22"] }, redis: { kind: "boolean" } },
      defaults: { node: "lts", redis: false },
      renames: {},
    });
  });
});

describe("recipe classification", () => {
  test("returns undefined when recipe is absent", () => {
    expect(classifyRecipe(entries("name: app\n").get("recipe"))).toBeUndefined();
  });
  test.each(["pantheon", "platformsh", "lagoon", "acquia"])("rejects hoster %s", (id) => {
    expect(classifyRecipe(entries(`recipe: ${id}\n`).get("recipe"))).toEqual({
      _tag: "unsupported",
      legacyId: id,
      reason: "hoster",
    });
  });
  test.each(["drupal7", "drupal8", "drupal9", "drupal12", "drupal010"])(
    "rejects unavailable major %s",
    (id) => {
      expect(classifyRecipe(entries(`recipe: ${id}\n`).get("recipe"))).toEqual({
        _tag: "unsupported",
        legacyId: id,
        reason: "no-v4-version",
      });
    },
  );
  test.each(["10", "11"])("pins drupal%s", (major) => {
    const map = BUNDLED_RECIPE_OPTION_MAPS.get("drupal");
    if (map === undefined) throw new Error("Expected drupal option table");
    expect(classifyRecipe(entries(`recipe: drupal${major}\n`).get("recipe"))).toEqual({
      _tag: "supported",
      legacyId: `drupal${major}`,
      recipeId: "drupal",
      pinned: { drupal: major },
      map,
    });
  });
  test("supports lamp without pins", () => {
    const map = BUNDLED_RECIPE_OPTION_MAPS.get("lamp");
    if (map === undefined) throw new Error("Expected lamp option table");
    expect(classifyRecipe(entries("recipe: lamp\n").get("recipe"))).toEqual({
      _tag: "supported",
      legacyId: "lamp",
      recipeId: "lamp",
      pinned: {},
      map,
    });
  });
  test("rejects unknown ids", () => {
    expect(classifyRecipe(entries("recipe: nonsense\n").get("recipe"))).toEqual({
      _tag: "unsupported",
      legacyId: "nonsense",
      reason: "unknown",
    });
  });
  test.each(["{name: lamp}", "[lamp]", "!load recipe.txt", "null", "3", "true"])(
    "rejects non-string %s",
    (yaml) => {
      expect(classifyRecipe(entries(`recipe: ${yaml}\n`).get("recipe"))).toMatchObject({
        _tag: "unsupported",
        reason: "non-string",
        legacyId: expect.any(String),
      });
    },
  );
});

describe("config option mapping", () => {
  test("maps numeric PHP and boolean Redis, dropping unsupported keys in source order", () => {
    const result = mapped(
      'recipe: wordpress\nconfig: {php: 8.3, redis: true, xdebug: true, composer_version: "2"}\n',
    );
    expect(result.options).toEqual({ php: "8.3", redis: true });
    expect(result.dropped.map(({ legacyKey }) => legacyKey)).toEqual(["xdebug", "composer_version"]);
    expect(result.invalid).toEqual([]);
  });
  test("renames drupal via", () => {
    expect(mapped("recipe: drupal\nconfig: {via: nginx}\n").options.webserver).toBe("nginx");
  });
  test("drops lamp via", () => {
    expect(mapped("recipe: lamp\nconfig: {via: nginx}\n").dropped.map(({ legacyKey }) => legacyKey)).toEqual([
      "via",
    ]);
  });
  test("rejects unsupported PHP and preserves default", () => {
    const result = mapped("recipe: lamp\nconfig: {php: 7.4}\n");
    expect(result.invalid).toMatchObject([
      {
        legacyKey: "php",
        option: "php",
        value: "7.4",
        spec: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
      },
    ]);
    expect(result.options.php).toBe("8.3");
  });
  test("documents lost numeric 8.10 spelling: wordpress rejects 8.1 without further coercion", () => {
    const result = mapped("recipe: wordpress\nconfig: {php: 8.10}\n");
    expect(result.invalid).toMatchObject([{ option: "php", value: "8.1" }]);
    expect(result.options.php).toBe("8.3");
  });
  test("retains quoted version spelling rather than treating 8.10 as 8.1", () => {
    const result = mapped('recipe: lamp\nconfig: {php: "8.10"}\n');
    expect(result.invalid).toMatchObject([{ option: "php", value: "8.10" }]);
    expect(result.options.php).toBe("8.3");
  });
  test("accepts false as a composer enum member", () => {
    expect(mapped("recipe: lamp\nconfig: {composer: false}\n").options.composer).toBe("false");
  });
  test("sorts option keys and applies mapped values over pins over defaults", () => {
    const result = mapped('recipe: drupal10\nconfig: {webroot: public, php: "8.4", drupal: 11}\n');
    expect(Object.keys(result.options)).toEqual([
      "composer",
      "database",
      "drupal",
      "php",
      "webroot",
      "webserver",
    ]);
    expect(result.options).toMatchObject({ drupal: "11", php: "8.4", webroot: "public" });
  });
  test.each(["", "config: null\n", "config: []\n", "config: !load config.yml\n"])(
    "uses defaults and pins for non-mapping config %s",
    (config) => {
      const result = mapped(`recipe: drupal10\n${config}`);
      expect(result.options.drupal).toBe("10");
      expect(result.dropped).toEqual([]);
      expect(result.invalid).toEqual([]);
    },
  );
  test.each(['"true"', "1", "null", "[]", "{}", "!load flag.txt"])(
    "rejects non-boolean redis %s",
    (value) => {
      const result = mapped(`recipe: wordpress\nconfig:\n  redis: ${value}\n`);
      expect(result.invalid).toMatchObject([{ option: "redis", spec: { kind: "boolean" } }]);
      expect(result.options.redis).toBe(false);
    },
  );
  test.each(['""', "null", "[]", "{}", "!load root.txt"])("rejects invalid string webroot %s", (value) => {
    const result = mapped(`recipe: lamp\nconfig:\n  webroot: ${value}\n`);
    expect(result.invalid).toMatchObject([{ option: "webroot", spec: { kind: "string" } }]);
    expect(result.options.webroot).toBe("/app");
  });
  test("rejects null enum and drops prototype keys and drush", () => {
    const result = mapped("recipe: lamp\nconfig: {php: null, constructor: x, __proto__: x, drush: 12}\n");
    expect(result.invalid).toMatchObject([{ option: "php", value: "null" }]);
    expect(result.dropped.map(({ legacyKey }) => legacyKey)).toEqual(["constructor", "__proto__", "drush"]);
  });
});
