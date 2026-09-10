import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { LANDO4_TRANSLATOR_ID, configTranslators } from "@lando/lando4";
import { loadLandofileLayers } from "@lando/landofile/service";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { drupalDecomposer } from "../../src/recipes/builtin/drupal/decomposer.ts";
import { drupalScaffoldCommand } from "../../src/recipes/builtin/drupal/scaffold-command.ts";
import { drupalDefaults, drupalProducer } from "../../src/recipes/builtin/drupal/snapshot.ts";

const loadTranslator = (): Effect.Effect<ConfigTranslatorShape> => {
  const loader = configTranslators.get(LANDO4_TRANSLATOR_ID);
  if (loader === undefined) throw new Error("The lando4 plugin must publish its translator loader.");
  return Effect.promise(async () => loader());
};

const encodedDrupalLandofile = (options: Readonly<Record<string, unknown>>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const decomposer = drupalDecomposer({ redactor: createStandaloneRedactor("secrets") });
    const decomposed = yield* decomposer.decompose({
      producer: drupalProducer,
      options,
      secrets: {},
    } as RecipeDecomposeInput);
    const context = { name: "drupalload", ...(decomposed.fragment as Record<string, unknown>) };
    const encode = (yield* loadTranslator()).encode;
    if (encode === undefined) throw new Error("The lando4 translator must publish an encoder.");
    const encoded = yield* encode({ context, fragment: context });
    return encoded.text;
  }).pipe(Effect.orDie);

const withEncodedApp = async <A>(
  options: Readonly<Record<string, unknown>>,
  run: (appRoot: string) => Promise<A>,
): Promise<A> => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-drupal-load-"));
  try {
    await writeFile(join(appRoot, ".lando.yml"), await Effect.runPromise(encodedDrupalLandofile(options)));
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
      const tooling = landofile.tooling as Record<string, Record<string, unknown>>;
      const services = landofile.services as Record<string, Record<string, unknown>>;
      const routes = services.appserver?.routes as ReadonlyArray<Record<string, unknown>>;
      expect(tooling["drupal-scaffold"]?.cmd).toBe(drupalScaffoldCommand(drupalDefaults.drupal));
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
      const tooling = landofile.tooling as Record<string, Record<string, unknown>>;
      const services = landofile.services as Record<string, Record<string, unknown>>;
      expect(tooling["drupal-scaffold"]?.cmd).toBe(drupalScaffoldCommand("10"));
      expect(services.appserver?.type).toBe("php:8.4");
    });
  });
});
