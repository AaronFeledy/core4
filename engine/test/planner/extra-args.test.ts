import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, ServiceName } from "@lando/sdk/schema";
import { type AppFeatureDefinition, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { bundledPluginModules } from "../../src/composition.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const replaceLauncher: AppFeatureDefinition = {
  id: "test.replace-launcher",
  priority: 100,
  selectors: { names: ["cache"] },
  apply: (ctx) => Effect.sync(() => ctx.forEachSelected((service) => service.setEntrypoint(["replacement"]))),
};

const plugin = definePlugin({
  name: "@example/replace-launcher",
  manifest: Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/replace-launcher",
    version: "1.0.0",
    api: 4,
    entry: "index.js",
    contributes: { appFeatures: [replaceLauncher.id] },
  }),
  appFeatures: new Map([[replaceLauncher.id, replaceLauncher]]),
});

const plan = (cache: Readonly<Record<string, unknown>>, replace = false) =>
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const appRoot = "/srv/launcher-args";
    const landofile = yield* compileTestLandofile(
      {
        name: "launcher-args",
        services: { cache: { type: "redis", ...cache }, peer: { type: "postgres", port: 5543 } },
      },
      appRoot,
    );
    return yield* planApp(
      { landofile, appRoot, providerCapabilities: TestRuntimeProvider.capabilities },
      Layer.succeed(PluginRegistry, registry),
    );
  }).pipe(
    Effect.provide(
      Registry.layerWith({ app: false, user: false }, [
        ...bundledPluginModules(),
        ...(replace ? [plugin] : []),
      ]),
    ),
  );

test("appends materialized tokens once without shell splitting", async () => {
  const result = await Effect.runPromise(
    plan({
      port: 6380,
      extraArgs: ["{{ service.port }}", "{{ services.peer.port }}", "a b", "x;|&", ""],
    }),
  );
  expect(result.services[ServiceName.make("cache")]?.command).toEqual([
    "redis-server",
    "--appendonly",
    "yes",
    "--port",
    "6380",
    "6380",
    "5543",
    "a b",
    "x;|&",
    "",
  ]);
});

test("rejects a reserved flag at its index after evaluating its port expression", async () => {
  const error = await Effect.runPromise(
    Effect.flip(plan({ extraArgs: ["--maxmemory", "10mb", "--port={{ service.port }}"] })),
  );
  expect(error).toBeInstanceOf(LandofileValidationError);
  if (error instanceof LandofileValidationError)
    expect(error.issues[0]).toMatchObject({
      path: ["services", "cache", "extraArgs", 2],
      suggestion: expect.stringContaining("port:"),
    });
});

test("fails when an app feature replaces the marked launcher's entrypoint", async () => {
  const error = await Effect.runPromise(Effect.flip(plan({ extraArgs: ["--maxmemory", "10mb"] }, true)));
  expect(error).toBeInstanceOf(LandofileValidationError);
  if (error instanceof LandofileValidationError)
    expect(error.issues[0]?.path).toEqual(["services", "cache", "extraArgs"]);
});

test("an empty list does not prevent an authored launcher", async () => {
  const result = await Effect.runPromise(plan({ command: ["custom"], extraArgs: [] }));
  expect(result.services[ServiceName.make("cache")]?.command).toEqual(["custom"]);
});

test.each([
  [{ type: "lando", image: "alpine:3" }, "command:"],
  [{ type: "compose", image: "alpine:3" }, "command:"],
  [{ type: "apache" }, "command:"],
  [{ type: "adminer" }, "command:"],
  [{ type: "dotnet" }, "command:"],
  [{ type: "elasticsearch" }, "environment"],
  [{ type: "go:1.22" }, "command:"],
  [{ type: "localstack" }, "environment"],
  [{ type: "mailhog" }, "environment"],
  [{ type: "mailpit" }, "environment"],
  [{ type: "meilisearch" }, "environment"],
  [{ type: "mssql" }, "environment"],
  [{ type: "nginx" }, "command:"],
  [{ type: "node:22", image: "example.test/node:custom" }, "command:"],
  [{ type: "opensearch" }, "environment"],
  [{ type: "php:8.3" }, "PHP"],
  [{ type: "php:8.3", via: "cli" }, "CLI"],
  [{ type: "phpmyadmin" }, "environment"],
  [{ type: "python:3.12" }, "command:"],
  [{ type: "rabbitmq" }, "environment"],
  [{ type: "ruby:3.3" }, "command:"],
  [{ type: "solr" }, "command:"],
  [{ type: "static" }, "command:"],
  [{ type: "static:caddy" }, "command:"],
  [{ type: "tomcat" }, "environment"],
  [{ type: "varnish", backend: "peer" }, "command:"],
  ...["postgres", "mysql", "mariadb", "mongodb"].map(
    (type) => [{ type, image: "example.test/db:custom" }, "catalog image"] as const,
  ),
] as const)("fails at extraArgs for unsupported %j", async (service, advice) => {
  const error = await Effect.runPromise(Effect.flip(plan({ ...service, extraArgs: ["--flag"] })));
  expect(error).toBeInstanceOf(LandofileValidationError);
  if (error instanceof LandofileValidationError)
    expect(error.issues[0]).toMatchObject({
      path: ["services", "cache", "extraArgs"],
      suggestion: expect.stringContaining(advice),
    });
});
