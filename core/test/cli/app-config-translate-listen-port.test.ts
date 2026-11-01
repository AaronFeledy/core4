import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { layerWith as pluginRegistryLayer } from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { withCwd } from "../_support/temp-cwd.ts";
import { withFixture } from "./translate-lando3-fixture.ts";

const bundledCatalog = pluginRegistryLayer({ user: false, app: false });

test.each([
  ["mysql:8.0", "MYSQL_TCP_PORT", 3307],
  ["mariadb:11.4", "MYSQL_TCP_PORT", 3307],
  ["postgres:16", "PGPORT", 5433],
  ["postgres:15", "PGPORT", 5433],
  ["postgres:17", "PGPORT", 5433],
  ["postgres:18", "PGPORT", 5433],
  ["node:24", "PORT", 3000],
  ["node:26", "PORT", 3000],
  ["mssql:2022", "MSSQL_TCP_PORT", 1435],
  ["rabbitmq:3", "RABBITMQ_NODE_PORT", 5673],
  ["phpmyadmin:5", "APACHE_PORT", 8081],
] as const)(
  "translates %s listener intent through bundled lint and planning",
  async (type, variable, port) => {
    await withFixture(async ({ root, run }) => {
      // Given
      await rm(join(root, ".lando.recipe.yml"));
      await rm(join(root, ".lando.local.yml"));
      const file = join(root, ".lando.yml");
      const database = type === "phpmyadmin:5" ? "  database:\n    type: mysql:8.0\n" : "";
      await Bun.write(
        file,
        `name: listener-drift\nservices:\n${database}  server:\n    type: ${type}\n    ssl: false\n    environment:\n      ${variable}: "${port}"\n`,
      );
      // When
      const translated = await Effect.runPromise(run());
      if (translated.mode !== "preview") throw new Error("Expected translation preview");
      const target = translated.targets[0];
      if (target === undefined) throw new Error("Missing translated Landofile");
      await Bun.write(file, target.content);
      const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(bundledCatalog)));
      const parsed = await Effect.runPromise(parseLandofile({ file, content: target.content, cwd: root }));
      const compiled = await Effect.runPromise(
        loadAuthoredDocuments([{ file, value: parsed }], { appRoot: root, file }),
      );
      const plan = await withCwd(
        root,
        () =>
          Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) =>
              planner.plan(compiled, {
                ...TestRuntimeProvider.capabilities,
                artifactBuild: true,
              }),
            ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(bundledCatalog)))),
          ),
        [root],
      );
      // Then
      if (variable !== "PORT")
        expect(translated.diagnostics).toContainEqual(
          expect.objectContaining({
            kind: "needs-review",
            keyPath: ["services", "server", "environment", variable],
          }),
        );
      else expect(translated.diagnostics).toEqual([]);
      expect(lint.valid).toBe(true);
      expect(lint.violations).toEqual([]);
      const server = plan.services[ServiceName.make("server")];
      expect(server?.environment[variable]).toBe(String(port));
      expect(server?.endpoints).toContainEqual(expect.objectContaining({ port, primary: true }));
    });
  },
);
