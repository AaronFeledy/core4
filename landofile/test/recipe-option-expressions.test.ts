import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { loadLandofileLayers } from "../src/service.ts";

const withApp = async <A>(files: Readonly<Record<string, string>>, run: (appRoot: string) => Promise<A>) => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-recipe-expression-"));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(appRoot, name), content);
    return await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) return "";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? String((failure.value as { message?: unknown }).message ?? "") : "";
};

const load = (appRoot: string) => loadLandofileLayers(appRoot, join(appRoot, ".lando.yml"));

const provenance = (options: string) =>
  [
    "recipe:",
    '  id: "lamp"',
    '  version: "0.1.0"',
    "  producer:",
    '    sourceKind: "bundled"',
    '    packageName: "@lando/recipe-lamp"',
    '    recipeId: "lamp"',
    '    manifestVersion: "0.1.0"',
    `    contentDigest: "sha256:${"0".repeat(64)}"`,
    "  options:",
    options,
  ].join("\n");

describe("recipe option expressions in a loaded Landofile", () => {
  test("materializes a whole recipe option reference from merged provenance", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance(['    php: "8.3"', '    webroot: "/app"'].join("\n")),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          '    webroot: "{{ recipe.webroot }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.3");
        expect(services.appserver?.webroot).toBe("/app");
      },
    );
  });

  test("reads options merged across layers rather than one file", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance(['    php: "8.3"'].join("\n")),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          "",
        ].join("\n"),
        ".lando.local.yml": [provenance('    php: "8.4"'), ""].join("\n"),
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.4");
      },
    );
  });

  test("leaves an app/proxy route hostname for the planner", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance('    php: "8.3"'),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          "    routes:",
          '      - hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"',
          "        scheme: both",
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        const routes = services.appserver?.routes as ReadonlyArray<Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.3");
        expect(routes[0]?.hostname).toBe("{{ app.name }}.{{ proxy.defaultDomain }}");
      },
    );
  });

  test("fails closed when a referenced option is absent", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance('    php: "8.3"'),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.missing }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("cannot resolve recipe option expressions");
      },
    );
  });

  test("fails closed when the Landofile records only a bare recipe id", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          "recipe: lamp",
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("cannot resolve recipe option expressions");
      },
    );
  });
});
