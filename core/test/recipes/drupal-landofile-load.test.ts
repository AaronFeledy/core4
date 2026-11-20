import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANDO4_TRANSLATOR_ID, configTranslators } from "@lando/lando4";
import { loadLandofileLayers } from "@lando/landofile/service";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { ConfigTranslateError, RecipeDecomposeError } from "@lando/sdk/errors";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { DRUPAL_CMS_PHP_INI_TARGET } from "../../src/recipes/builtin/drupal-cms/php-config.ts";
import { bundledRecipe } from "../_support/bundled-recipe.ts";

const {
  decomposer: drupalDecomposer,
  defaults: drupalDefaults,
  producer: drupalProducer,
} = bundledRecipe("drupal");
const {
  decomposer: drupalCmsDecomposer,
  defaults: drupalCmsDefaults,
  producer: drupalCmsProducer,
} = bundledRecipe("drupal-cms");
const {
  decomposer: drupalContribDecomposer,
  defaults: drupalContribDefaults,
  producer: drupalContribProducer,
} = bundledRecipe("drupal-contrib");

const loadTranslator = (): Effect.Effect<ConfigTranslatorShape> => {
  const loader = configTranslators.get(LANDO4_TRANSLATOR_ID);
  if (loader === undefined) throw new Error("The lando4 plugin must publish its translator loader.");
  return Effect.promise(async () => loader());
};

const encodedDrupalLandofile = Effect.fnUntraced(function* (
  options: Readonly<Record<string, unknown>>,
  cms = false,
): Effect.fn.Return<string, ConfigTranslateError | RecipeDecomposeError> {
  const decomposer = cms
    ? drupalCmsDecomposer({ redactor: createStandaloneRedactor("secrets") })
    : drupalDecomposer({ redactor: createStandaloneRedactor("secrets") });
  const decomposed = yield* decomposer.decompose({
    producer: cms ? drupalCmsProducer : drupalProducer,
    options,
    secrets: {},
  } as RecipeDecomposeInput);
  const context = { name: "drupalload", ...(decomposed.fragment as Record<string, unknown>) };
  const encode = (yield* loadTranslator()).encode;
  if (encode === undefined) throw new Error("The lando4 translator must publish an encoder.");
  const encoded = yield* encode({ context, fragment: context });
  return encoded.text;
}, Effect.orDie);

const withEncodedApp = async <A>(
  options: Readonly<Record<string, unknown>>,
  run: (appRoot: string) => Promise<A>,
  cms = false,
): Promise<A> => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-drupal-load-"));
  try {
    await writeFile(
      join(appRoot, ".lando.yml"),
      await Effect.runPromise(encodedDrupalLandofile(options, cms)),
    );
    return await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

describe("the decomposed drupal Landofile on the native load path", () => {
  test("loads with the scaffold command resolved and every shell parameter preserved", async () => {
    await withEncodedApp({ ...drupalDefaults }, async (appRoot) => {
      // When
      const landofile = await Effect.runPromise(loadLandofileLayers(appRoot, join(appRoot, ".lando.yml")));

      // Then
      const tooling = landofile.document.tooling as Record<string, Record<string, unknown>>;
      const services = landofile.document.services as Record<string, Record<string, unknown>>;
      const routes = services.appserver?.routes as ReadonlyArray<Record<string, unknown>>;
      const drupalVersion = drupalDefaults.drupal;
      if (typeof drupalVersion !== "string") throw new TypeError("Expected a Drupal version default");
      expect(tooling["drupal-scaffold"]?.cmd).toBe(`lando-drupal-scaffold ${drupalVersion}`);
      expect(tooling.drush?.wrapper).toBe(true);
      expect(tooling.composer?.wrapper).toBe(true);
      expect(tooling.phpcs?.wrapper).toBe(true);
      const phpcsCmds = tooling.phpcs?.cmds;
      expect(Array.isArray(phpcsCmds) ? phpcsCmds[0] : undefined).toContain(
        `lando_phpcs_webroot="${drupalDefaults.webroot}"`,
      );
      expect(Array.isArray(phpcsCmds) ? phpcsCmds[0] : undefined).toContain(
        "$lando_phpcs_webroot/modules/custom",
      );
      expect(Array.isArray(phpcsCmds) ? phpcsCmds[0] : undefined).not.toContain("{{ recipe.webroot }}");
      expect(services.appserver?.type).toBe(`php:${drupalDefaults.php}`);
      expect(services.appserver?.webroot).toBe(drupalDefaults.webroot);
      expect(services.database?.type).toBe(drupalDefaults.database);
      expect(routes[0]?.hostname).toBe("{{ app.name }}.{{ proxy.defaultDomain }}");
    });
  });

  test("carries a nondefault drupal major into the resolved scaffold command", async () => {
    await withEncodedApp({ ...drupalDefaults, drupal: "10", php: "8.4" }, async (appRoot) => {
      // When
      const landofile = await Effect.runPromise(loadLandofileLayers(appRoot, join(appRoot, ".lando.yml")));

      // Then
      const tooling = landofile.document.tooling as Record<string, Record<string, unknown>>;
      const services = landofile.document.services as Record<string, Record<string, unknown>>;
      expect(tooling["drupal-scaffold"]?.cmd).toBe("lando-drupal-scaffold 10");
      expect(services.appserver?.type).toBe("php:8.4");
    });
  });
});

describe("the decomposed Drupal CMS Landofile on the native load path", () => {
  test("loads the scaffold command, PHP mount, and database configuration", async () => {
    await withEncodedApp(
      { ...drupalCmsDefaults },
      async (appRoot) => {
        const landofile = await Effect.runPromise(loadLandofileLayers(appRoot, join(appRoot, ".lando.yml")));
        const tooling = landofile.document.tooling as Record<string, Record<string, unknown>>;
        const services = landofile.document.services as Record<string, Record<string, unknown>>;
        expect(tooling["drupal-cms-scaffold"]?.cmd).toBe("lando-drupal-cms-scaffold");
        expect(tooling.drush?.wrapper).toBe(true);
        expect(tooling.composer?.wrapper).toBe(true);
        expect(tooling.phpstan?.wrapper).toBe(true);
        const phpstanCmds = tooling.phpstan?.cmds;
        expect(Array.isArray(phpstanCmds) ? phpstanCmds[0] : undefined).toContain(
          `lando_phpstan_webroot="${drupalCmsDefaults.webroot}"`,
        );
        expect(Array.isArray(phpstanCmds) ? phpstanCmds[0] : undefined).toContain(
          "$lando_phpstan_webroot/themes/custom",
        );
        expect(Array.isArray(phpstanCmds) ? phpstanCmds[0] : undefined).not.toContain("{{ recipe.webroot }}");
        expect(services.appserver?.type).toBe(`php:${drupalCmsDefaults.php}`);
        expect(services.appserver?.webroot).toBe(drupalCmsDefaults.webroot);
        expect(services.database?.type).toBe(drupalCmsDefaults.database);
        expect(services.appserver?.mounts).toEqual([
          { source: "./.lando/php/drupal-cms.ini", target: DRUPAL_CMS_PHP_INI_TARGET, readOnly: true },
        ]);
      },
      true,
    );
  });
});

describe("the decomposed Drupal contrib Landofile on the native load path", () => {
  test("loads the nested mount, site volume, chrome service, and site sync", async () => {
    const options = {
      ...drupalContribDefaults,
      type: "theme",
      project: "hello_theme",
      drupal: ">=10 <11 || ^11",
    };
    const decomposer = drupalContribDecomposer({ redactor: createStandaloneRedactor("secrets") });
    const decomposed = Effect.runSync(
      decomposer.decompose({
        producer: drupalContribProducer,
        options,
        secrets: {},
      }),
    );
    const context = { name: "drupalcontribload", ...(decomposed.fragment as Record<string, unknown>) };
    const encode = (await Effect.runPromise(loadTranslator())).encode;
    if (encode === undefined) throw new Error("The lando4 translator must publish an encoder.");
    const encoded = await Effect.runPromise(encode({ context, fragment: context }));
    const appRoot = await mkdtemp(join(tmpdir(), "lando-drupal-contrib-load-"));
    try {
      await writeFile(join(appRoot, ".lando.yml"), encoded.text);
      const landofile = await Effect.runPromise(loadLandofileLayers(appRoot, join(appRoot, ".lando.yml")));
      const tooling = landofile.document.tooling as Record<string, Record<string, unknown>>;
      const services = landofile.document.services as Record<string, Record<string, unknown>>;
      expect(tooling["drupal-contrib-sync"]?.cmd).toEqual([
        "lando-drupal-contrib-sync",
        "theme",
        "hello_theme",
        ">=10 <11 || ^11",
      ]);
      expect(landofile.document.events).toEqual({ "post-start": [{ task: "drupal-contrib-sync" }] });
      expect(tooling.composer?.dir).toBe("/app");
      expect(tooling.phpunit?.user).toBe("www-data");
      expect(services.appserver?.webroot).toBe("/app/web");
      expect(services.appserver?.appMount).toEqual({
        target: "/app/web/themes/custom/hello_theme",
        includes: ["vendor", "node_modules", "tmp"],
      });
      expect(services.chrome?.type).toBe("compose");
      expect(services.chrome?.image).toBe("selenium/standalone-chromium:155.0-20261010");
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
});
