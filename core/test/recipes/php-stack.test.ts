import { describe, expect, test } from "bun:test";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import { bundledRecipe } from "../_support/bundled-recipe.ts";
import { loadBuiltinRecipe } from "../_support/recipe-output.ts";

describe("compiled PHP source behavior", () => {
  test("publishes all PHP versions with the intended default", () => {
    const { snapshot } = bundledRecipe("lamp");
    expect(snapshot.optionTypes.php).toEqual({
      kind: "enum",
      values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"],
    });
    expect(snapshot.defaults).toEqual({ php: "8.4", database: "mariadb:11.4", composer: "2", webroot: "." });
  });
  test.each(["/app", "/app/web", "/app/public", ".", "web", "./public/"])(
    "retains supported webroot %s",
    async (webroot) => {
      const loaded = await loadBuiltinRecipe("lamp", { webroot });
      expect(loaded.document.services?.[ServiceName.make("appserver")]?.webroot).toBe(
        PortablePath.make(webroot),
      );
    },
  );
  test.each(["", "public files", "web;echo"])(
    "rejects unsupported webroot %s before encoding",
    async (webroot) => {
      await expect(loadBuiltinRecipe("lamp", { webroot })).rejects.toMatchObject({
        _tag: "RecipeInitBlockedError",
        stage: "translate",
      });
    },
  );
  test("resolves Apache defaults with versioned PHP and database, routes and override support", async () => {
    const loaded = await loadBuiltinRecipe("drupal");
    const app = loaded.document.services?.[ServiceName.make("appserver")];
    expect(app).toMatchObject({
      type: "php:8.4",
      primary: true,
      allowOverride: true,
      port: 80,
      composer: "2",
    });
    expect(app?.via).toBeUndefined();
    expect(app?.routes).toEqual([{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }]);
    expect(loaded.document.services?.[ServiceName.make("database")]?.type).toBe("mariadb:11.4");
  });
  test("places nginx routes on an edge and leaves FPM without Apache fields", async () => {
    const loaded = await loadBuiltinRecipe("drupal", {
      webserver: "nginx",
      webroot: ".",
      database: "postgres:16",
    });
    const app = loaded.document.services?.[ServiceName.make("appserver")];
    expect(app).toMatchObject({ via: "fpm", primary: true });
    expect(app?.routes).toBeUndefined();
    expect(app?.port).toBeUndefined();
    expect(app?.allowOverride).toBeUndefined();
    expect(loaded.document.services?.[ServiceName.make("edge")]).toMatchObject({
      backend: "appserver",
      webroot: ".",
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    });
    expect(loaded.document.services?.[ServiceName.make("database")]?.type).toBe("postgres:16");
  });
  test("retains typed false composer after the generated Landofile reloads", async () => {
    const loaded = await loadBuiltinRecipe("lamp", { composer: false });
    expect(loaded.document.services?.[ServiceName.make("appserver")]?.composer).toBe(false);
    expect(loaded.document.tooling?.composer).toBeUndefined();
  });
  test("keeps each framework's database default", () => {
    expect(bundledRecipe("laravel").snapshot.defaults.database).toBe("mariadb:11.4");
    expect(bundledRecipe("symfony").snapshot.defaults.database).toBe("postgres:16");
  });
});
