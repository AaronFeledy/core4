import { describe, expect, test } from "bun:test";

import { initApp } from "../../src/cli/commands/init.ts";
import { discoverFrom, withTempCwd } from "./support/init-recipe-harness.ts";

describe("lando init — Drupal recipe", () => {
  test("renders safe scaffolding with project-local Drush", async () => {
    await withTempCwd(async (dir) => {
      // Given: a fresh Drupal recipe whose generated Landofile already occupies the app root.
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "drupal",
        nonInteractive: true,
        answers: { name: "drupal-scaffold-app", php: "8.3", database: "mariadb" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      // When: the generated Landofile is decoded through the production service.
      const landofile = await discoverFrom(result.directory);
      const scaffoldTask = landofile.tooling?.["drupal-scaffold"];
      const command = scaffoldTask?.cmd;

      // Then: scaffolding is isolated, installs Drush, and merges into the mounted app root.
      expect(scaffoldTask?.service).toBe("appserver");
      expect(typeof command).toBe("string");
      expect(command).toContain("test ! -e /app/composer.json");
      expect(command).toContain("mktemp -d");
      expect(command).toContain("composer create-project drupal/recommended-project");
      expect(command).toContain('composer require --working-dir="$destination" drush/drush');
      expect(command).toContain('cp -a "$destination"/. /app/');
      expect(landofile.tooling?.drush?.cmds).toEqual(["vendor/bin/drush"]);
    });
  });
});
