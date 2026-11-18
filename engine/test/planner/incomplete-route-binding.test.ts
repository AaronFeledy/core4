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

test("incomplete contributions retain numeric route conflicts without inventing missing listeners", async () => {
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
  try {
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument({
        name: "incomplete-bindings",
        services: {
          web: {
            type: "php:8.3",
            via: "fpm",
            endpoints: ["http:8080", "udp:8080", "udp:8082"],
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
    expect(lint.violations.map(({ rule, path, reason }) => ({ rule, path, reason }))).toEqual([
      { rule: "landofile.service", path: ["services", "missing", "type"], reason: undefined },
      {
        rule: "landofile.route",
        path: ["services", "web", "routes", 2],
        reason: "route-endpoint-protocol-conflict",
      },
      {
        rule: "landofile.route",
        path: ["services", "web", "routes", 3],
        reason: "route-endpoint-protocol-conflict",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
