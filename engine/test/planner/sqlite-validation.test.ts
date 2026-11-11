import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseConnection } from "@lando/sdk/schema";
import { PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Layer, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const creds = { user: "lando", password: "secret", database: "app" };
const connection = Schema.decodeUnknownSync(DatabaseConnection)({ family: "postgres", port: 5432, creds });
const serviceType: ServiceType = {
  id: "sqlite-validation",
  name: "sqlite-validation",
  base: "l337",
  schema: Schema.Unknown,
  resolve: ({ service }) =>
    Effect.succeed({
      base: "l337",
      normalizedConfig: service,
      features: [],
      ...(service.environment?.KIND === "connection" ? { connection } : {}),
      ...(service.environment?.KIND === "credentials" ? { nonSqlCreds: creds } : {}),
    }),
};
const registryLayer = Layer.effect(
  PluginRegistry,
  Effect.map(PluginRegistry, (registry) =>
    PluginRegistry.of({
      ...registry,
      loadServiceType: (id) =>
        id === serviceType.id ? Effect.succeed(serviceType) : registry.loadServiceType(id),
    }),
  ),
).pipe(Layer.provide(PluginRegistryLayer.layer));

test.each(["connection", "credentials", "no-mount", "disabled-mount"])(
  "config lint rejects SQLite on a service with %s and suggests a correction",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-sqlite-lint-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        emitYamlDocument({
          name: "sqlite-lint",
          services: {
            web: {
              type: serviceType.id,
              image: "alpine:3.22",
              sqlite: { path: "data/site.sqlite" },
              environment: { KIND: kind },
              ...(kind === "disabled-mount" ? { appMount: false } : {}),
            },
          },
        }),
      );
      const lint = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer), Effect.provide(BunFileSystem.layer)),
      );
      expect(lint.valid).toBe(false);
      expect(lint.violations).toContainEqual(
        expect.objectContaining({
          path: ["services", "web", "sqlite"],
          severity: "error",
          message: expect.stringContaining(
            kind === "connection" || kind === "credentials" ? "cannot coexist" : "requires an app mount",
          ),
          suggestion: expect.stringContaining(
            kind === "connection" || kind === "credentials" ? "separate app service" : "app mount",
          ),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
