import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Schema } from "effect";
import { bundledPluginModules } from "../../src/composition.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Registry from "../../src/plugins/registry.ts";

test.each([
  { label: "explicit endpoints", endpoints: ["http:8080", "udp:8080", "udp:8082"], conflicts: [2, 3] },
  { label: "omitted endpoints", endpoints: undefined, conflicts: [2] },
])("reports only known route conflicts with $label", async ({ endpoints, conflicts }) => {
  const feature: AppFeatureDefinition = {
    id: "test.listeners",
    priority: 100,
    selectors: { fromConfig: '{{ ["web"] }}' },
    declareEndpoints: () => Effect.succeed({ web: ["http:8081"] }),
    apply: () => Effect.void,
  };
  const registry = Registry.layerWith({ app: false, user: false }, [
    ...bundledPluginModules(),
    definePlugin({
      name: "@test/listeners",
      manifest: Schema.decodeUnknownSync(PluginManifest)({
        name: "@test/listeners",
        version: "1.0.0",
        api: 4,
        entry: "index.js",
        contributes: { appFeatures: [feature.id] },
      }),
      appFeatures: new Map([[feature.id, feature]]),
    }),
  ]);
  const root = await mkdtemp(join(tmpdir(), "lando-incomplete-bindings-"));
  const file = join(root, ".lando.yml");
  try {
    await writeFile(
      file,
      emitYamlDocument({
        name: "incomplete-bindings",
        services: {
          web: {
            type: "php:8.3",
            via: "fpm",
            ...(endpoints === undefined ? {} : { endpoints }),
            routes: [
              "web.lndo.site:8080",
              "unknown.lndo.site:8081",
              "php.lndo.site:9000",
              "udp.lndo.site:8082",
            ],
          },
          missing: { type: "unregistered" },
        },
      }),
    );
    const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registry)));
    expect(lint.violations).toMatchObject([
      { rule: "landofile.service", path: ["services", "missing", "type"] },
      ...conflicts.map((index) => ({
        rule: "landofile.route",
        path: ["services", "web", "routes", index],
        reason: "route-endpoint-protocol-conflict",
        source: { file, path: ["services", "web", "routes", index] },
      })),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
