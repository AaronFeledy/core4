import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@lando/sdk/plugins";
import { type EndpointPlan, PluginManifest, ServiceName } from "@lando/sdk/schema";
import {
  type AppFeatureDefinition,
  CacheService,
  PluginRegistry,
  RuntimeProvider,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Layer, Schema } from "effect";
import { bundledPluginModules } from "../../src/composition.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const listener = (port: number): EndpointPlan => ({ _tag: "internal", protocol: "http", port });
const buildPlugin = (calls: string[], endpoint: number): ReturnType<typeof definePlugin> => {
  const metadata = Object.freeze({ "@test/resolution": Object.freeze({ listener: endpoint }) });
  const feature: ServiceFeatureDefinition = {
    id: "test.listener",
    priority: 700,
    schema: Schema.Struct({ port: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))) }),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        calls.push("service-declaration");
        expect("addEndpoint" in ctx).toBe(false);
        expect("addEnv" in ctx).toBe(false);
        expect(ctx.config.port).toBe(endpoint);
        return [listener(endpoint)];
      }),
    apply: () =>
      Effect.sync(() => {
        calls.push("service-apply");
      }),
  };
  const late: AppFeatureDefinition = {
    id: "test.late-listener",
    priority: 900,
    activatedBy: { services: { hasFeature: feature.id } },
    selectors: { fromConfig: '{{ ["web"] }}' },
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        calls.push("app-declaration");
        expect("forEachSelected" in ctx).toBe(false);
        expect(ctx.selected.map((view) => view.serviceName)).toEqual(["web"]);
        expect(ctx.selected[0]?.resolutionMetadata).toEqual(metadata);
        return { web: [{ ...listener(9000), name: "late" }] };
      }),
    apply: (ctx) =>
      Effect.sync(() => {
        expect(ctx.selected[0]?.resolutionMetadata).toEqual(metadata);
        ctx.forEachSelected((service) => expect(service.service.resolutionMetadata).toEqual(metadata));
        calls.push("app-apply");
      }),
  };
  const type: ServiceType = {
    id: "declaration",
    name: "declaration",
    base: "l337",
    schema: Schema.Unknown,
    resolve: ({ service }) =>
      Effect.succeed({
        base: "l337",
        normalizedConfig: service,
        metadata,
        features: [{ id: feature.id, config: { port: endpoint } }],
      }),
  };
  return definePlugin({
    name: "@test/declarations",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/declarations",
      version: "1.0.0",
      api: 4,
      entry: "index.js",
      contributes: { serviceTypes: [type.id], serviceFeatures: [feature.id], appFeatures: [late.id] },
    }),
    serviceTypes: new Map([[type.id, type]]),
    serviceFeatures: new Map([[feature.id, feature]]),
    appFeatures: new Map([[late.id, late]]),
  });
};

test("lint declares service and app listeners without apply, certificates, provider or cache", async () => {
  // Given
  const calls: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "lando-declarations-"));
  const registry = PluginRegistryLayer.layerWith({ app: false, user: false }, [
    ...bundledPluginModules(),
    buildPlugin(calls, 8080),
  ]);
  try {
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument({
        name: "declarations",
        services: {
          web: {
            type: "declaration",
            certs: true,
            routes: [{ hostname: "app.lndo.site", endpoint: "late" }],
          },
        },
      }),
    );
    const trap = (name: string) =>
      Effect.sync(() => {
        calls.push(name);
      });
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(
        Effect.provide(registry),
        Effect.provideService(RuntimeProvider, {
          ...TestRuntimeProvider,
          getStatus: trap("provider").pipe(Effect.andThen(TestRuntimeProvider.getStatus)),
        }),
        Effect.provideService(CacheService, {
          read: () => trap("cache-read").pipe(Effect.as(null)),
          write: () => trap("cache-write"),
          invalidate: () => trap("cache-invalidate"),
          writeAtomic: () => trap("cache-atomic"),
        }),
        Effect.provideService(CertificateAuthorityResolver, {
          resolve: trap("certificate").pipe(Effect.andThen(Effect.die("unexpected certificate issuance"))),
        }),
      ),
    );
    // Then
    expect(result.valid).toBe(true);
    expect(calls).toEqual(["service-declaration", "app-declaration"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning consumes the projected declarations once before applying features", async () => {
  // Given
  const calls: string[] = [];
  const registry = PluginRegistryLayer.layerWith({ app: false, user: false }, [
    ...bundledPluginModules(),
    buildPlugin(calls, 8080),
  ]);
  const root = "/srv/endpoint-declarations";
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* planApp(
        {
          landofile: yield* compileTestLandofile(
            {
              name: "declarations",
              services: {
                web: {
                  type: "declaration",
                  home: false,
                  routes: [{ hostname: "app.lndo.site", endpoint: "late" }],
                },
              },
            },
            root,
          ),
          providerCapabilities: TestRuntimeProvider.capabilities,
          appRoot: root,
        },
        Layer.succeed(PluginRegistry, yield* PluginRegistry),
      );
    }).pipe(Effect.provide(registry)),
  );
  // Then
  expect(calls).toEqual(["service-declaration", "app-declaration", "service-apply", "app-apply"]);
  expect(result.services[ServiceName.make("web")]?.endpoints).toEqual([
    listener(8080),
    { ...listener(9000), name: "late" },
  ]);
  expect(result.routes[0]?.backend.port).toBe(9000);
});

test.each([false, true])(
  "incomplete app activation preserves explicit endpoint authority: %s",
  async (explicit) => {
    // Given
    const calls: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "lando-declaration-unavailable-"));
    const registry = PluginRegistryLayer.layerWith({ app: false, user: false }, [
      ...bundledPluginModules(),
      buildPlugin(calls, 8080),
    ]);
    try {
      await writeFile(
        join(root, ".lando.yml"),
        emitYamlDocument({
          name: "declarations",
          services: {
            web: { type: "declaration", ...(explicit ? { endpoints: [] } : {}), routes: ["web.lndo.site"] },
            missing: { type: "unregistered" },
          },
        }),
      );
      // When
      const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registry)));
      // Then
      expect(
        result.violations.filter(({ rule }) => rule === "landofile.route").map(({ path }) => path),
      ).toEqual(explicit ? [["services", "web", "routes", 0]] : []);
      expect(result.violations.filter(({ rule }) => rule === "landofile.service")).toHaveLength(1);
      expect(calls).toEqual(["service-declaration"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("declarations receive original feature config before planner-owned SSH substitution", async () => {
  // Given
  const seen: unknown[] = [];
  const feature: ServiceFeatureDefinition = {
    id: "lando.ssh-agent",
    priority: 300,
    schema: Schema.Unknown,
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        seen.push(ctx.config);
        return [listener(8123)];
      }),
    apply: (ctx) =>
      Effect.sync(() => {
        seen.push(ctx.config);
      }),
  };
  const type: ServiceType = {
    id: "declared-ssh",
    name: "declared-ssh",
    base: "l337",
    schema: Schema.Unknown,
    resolve: ({ service }) =>
      Effect.succeed({
        base: "l337",
        normalizedConfig: service,
        features: [{ id: feature.id, config: { listenerPort: 8123 } }],
      }),
  };
  const registry = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (base) =>
      PluginRegistry.of({
        ...base,
        loadServiceType: (id) => (id === type.id ? Effect.succeed(type) : base.loadServiceType(id)),
        loadServiceFeature: (id) =>
          id === feature.id ? Effect.succeed(feature) : base.loadServiceFeature(id),
      }),
    ),
  ).pipe(Layer.provide(PluginRegistryLayer.layer));
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* planApp(
        {
          landofile: yield* compileTestLandofile(
            {
              name: "original-config",
              services: { web: { type: type.id, home: false, routes: ["original.lndo.site"] } },
            },
            "/srv/original-config",
          ),
          providerCapabilities: TestRuntimeProvider.capabilities,
          appRoot: "/srv/original-config",
        },
        Layer.succeed(PluginRegistry, yield* PluginRegistry),
      );
    }).pipe(Effect.provide(registry)),
  );
  // Then
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual({ listenerPort: 8123 });
  expect(seen[1]).toMatchObject({ mode: expect.any(String) });
  expect(result.routes[0]?.backend.port).toBe(8123);
});

test("an invalid declaration config is unavailable rather than a missing-HTTP cascade", async () => {
  // Given
  const calls: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "lando-declaration-invalid-"));
  const registry = PluginRegistryLayer.layerWith({ app: false, user: false }, [
    ...bundledPluginModules(),
    buildPlugin(calls, -1),
  ]);
  try {
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument({
        name: "declarations",
        services: {
          web: { type: "declaration", routes: ["web.lndo.site"] },
          independent: { type: "compose", image: "alpine:3", routes: ["independent.lndo.site"] },
        },
      }),
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registry)));
    // Then
    expect(
      result.violations.filter(({ rule }) => rule === "landofile.route").map(({ path }) => path),
    ).toEqual([["services", "independent", "routes", 0]]);
    expect(result.violations.filter(({ rule }) => rule === "landofile.service")).toHaveLength(1);
    expect(calls).toEqual(["app-declaration"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
