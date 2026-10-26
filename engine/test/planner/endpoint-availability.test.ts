import { expect, test } from "bun:test";
import { PluginLoadError, ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, type ServiceConfig } from "@lando/sdk/schema";
import {
  type AppFeatureDefinition,
  PluginRegistry,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { resolveLandofileForPlanning } from "../../src/planner/event-set.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const root = "/srv/availability";
const resolve = (
  services: Readonly<Record<string, ServiceConfig>>,
  options: {
    readonly feature?: ServiceFeatureDefinition;
    readonly app?: AppFeatureDefinition;
    readonly apps?: readonly AppFeatureDefinition[];
    readonly failAppLoad?: boolean;
  } = {},
) => {
  const type: ServiceType = {
    id: "availability",
    name: "availability",
    base: "l337",
    schema: Schema.Unknown,
    resolve: ({ service }) =>
      service.environment?.FAIL === "yes"
        ? Effect.fail(
            new ServiceTypeError({
              serviceType: "availability",
              message: "invalid seed",
              issues: [{ path: ["port"], message: "invalid seed" }],
              remediation:
                "Correct the `availability` service configuration in the Landofile (see the reported field path), then re-run.",
            }),
          )
        : Effect.succeed({
            base: "l337",
            normalizedConfig: service,
            nonSqlCreds: { user: "user", database: "db", password: "secret" },
            features: options.feature === undefined ? [] : [{ id: options.feature.id }],
          }),
  };
  const plugin = definePlugin({
    name: "@test/availability",
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: "@test/availability",
      version: "1.0.0",
      api: 4,
      entry: "index.js",
      contributes: {
        serviceTypes: [type.id],
        serviceFeatures: options.feature === undefined ? [] : [options.feature.id],
        appFeatures: [...(options.app === undefined ? [] : [options.app]), ...(options.apps ?? [])].map(
          (app) => app.id,
        ),
      },
    }),
    serviceTypes: new Map([[type.id, type]]),
    serviceFeatures: new Map(options.feature === undefined ? [] : [[options.feature.id, options.feature]]),
    appFeatures: new Map(
      [...(options.app === undefined ? [] : [options.app]), ...(options.apps ?? [])].map((app) => [
        app.id,
        app,
      ]),
    ),
  });
  const registry = Registry.layerWith({ app: false, user: false }, [plugin]);
  const failedRegistry = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (base) =>
      PluginRegistry.of({
        ...base,
        loadAppFeature: (id) =>
          options.failAppLoad
            ? Effect.fail(
                new PluginLoadError({
                  pluginName: id,
                  message: "app load failed",
                  remediation: "Install or register the plugin, then retry.",
                }),
              )
            : base.loadAppFeature(id),
      }),
    ),
  ).pipe(Layer.provide(registry));
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* resolveLandofileForPlanning({
        landofile: yield* compileTestLandofile({ name: "availability", services }, root),
        pluginRegistry: yield* PluginRegistry,
        configService: undefined,
        fileSystem: undefined,
        pathsService: undefined,
      });
    }).pipe(Effect.provide(options.failAppLoad ? failedRegistry : registry)),
  );
};

test("every authored service has an explicit endpoint row and blocked consumers retain deduplicated root reasons", async () => {
  const result = await resolve({
    db: { type: "availability", environment: { FAIL: "yes" }, routes: ["db.lndo.site"] },
    consumer: {
      type: "availability",
      environment: { USER: "{{ services.db.creds.user }}" },
      routes: ["consumer.lndo.site"],
    },
    transitive: {
      type: "availability",
      environment: { USER: "{{ services.consumer.creds.user }}", DIRECT: "{{ services.db.creds.user }}" },
    },
    empty: { type: "availability" },
  });
  expect(result._tag).toBe("Invalid");
  const rows = result.resolution.endpointProjection.services;
  expect([...rows.keys()].sort()).toEqual(["consumer", "db", "empty", "transitive"]);
  for (const name of ["db", "consumer", "transitive"]) {
    const row = rows.get(name);
    expect(row?.preparation._tag).toBe("Unavailable");
    expect(row?.endpoints._tag).toBe("Unavailable");
    if (row?.endpoints._tag === "Unavailable") {
      expect(row.endpoints.reasons).toHaveLength(1);
      expect(row.endpoints.reasons[0]?.path).toEqual(["services", "db", "port"]);
    }
  }
  expect(rows.get("empty")?.endpoints).toEqual({ _tag: "Available", value: [] });
  if (result._tag === "Invalid")
    expect(result.issues.map((issue) => issue.path)).toEqual([["services", "db", "port"]]);
});

test("declaration failure retains selector facts but app declarations cannot repair failed contributions", async () => {
  const selected: string[][] = [];
  const feature: ServiceFeatureDefinition = {
    id: "test.invalid-declaration",
    priority: 100,
    declareEndpoints: () =>
      Effect.fail(
        new ServiceFeatureError({
          feature: "test.invalid-declaration",
          message: "declaration failed",
          remediation:
            "Correct the `test.invalid-declaration` feature configuration in the Landofile, then re-run.",
        }),
      ),
    apply: () => Effect.void,
  };
  const app: AppFeatureDefinition = {
    id: "test.app",
    priority: 100,
    selectors: { hasFeature: [feature.id] },
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        selected.push(ctx.selected.map((view) => view.serviceName));
        return { web: [{ _tag: "internal", protocol: "http", port: 8123 }] };
      }),
    apply: () => Effect.void,
  };
  const result = await resolve(
    { web: { type: "availability", routes: ["web.lndo.site"] } },
    { feature, app },
  );
  expect(selected).toEqual([["web"]]);
  const row = result.resolution.endpointProjection.services.get("web");
  expect(row?.preparation._tag).toBe("Available");
  expect(row?.contributions._tag).toBe("Unavailable");
  expect(row?.endpoints._tag).toBe("Unavailable");
  if (result._tag === "Invalid")
    expect(result.issues.map((issue) => issue.rule)).toEqual(["landofile.service"]);
});

test("explicit empty endpoints remain authoritative without hiding a declaration failure", async () => {
  const feature: ServiceFeatureDefinition = {
    id: "test.invalid",
    priority: 100,
    declareEndpoints: () =>
      Effect.fail(
        new ServiceFeatureError({
          feature: "test.invalid",
          message: "failed",
          remediation: "Correct the `test.invalid` feature configuration in the Landofile, then re-run.",
        }),
      ),
    apply: () => Effect.void,
  };
  const result = await resolve(
    { web: { type: "availability", endpoints: [], routes: ["web.lndo.site"] } },
    { feature },
  );
  expect(result.resolution.endpointProjection.services.get("web")?.endpoints).toEqual({
    _tag: "Available",
    value: [],
  });
  expect(result._tag).toBe("Invalid");
  if (result._tag === "Invalid")
    expect(result.issues.map((issue) => issue.rule)).toEqual(["landofile.service", "landofile.route"]);
});

test("endpoint invariant failures suppress dependent route binding errors", async () => {
  const feature: ServiceFeatureDefinition = {
    id: "test.invariant",
    priority: 100,
    declareEndpoints: () =>
      Effect.succeed([
        { _tag: "internal", name: "same", protocol: "http", port: 8123 },
        { _tag: "internal", name: "same", protocol: "http", port: 9234 },
      ]),
    apply: () => Effect.void,
  };
  const result = await resolve({ web: { type: "availability", routes: ["web.lndo.site"] } }, { feature });
  expect(result.resolution.endpointProjection.services.get("web")?.endpoints._tag).toBe("Unavailable");
  if (result._tag === "Invalid") {
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.filter((issue) => issue.rule === "landofile.route")).toEqual([]);
  }
});

test("incomplete facts skip app declarations and affect only known static matches", async () => {
  let declarations = 0;
  const app: AppFeatureDefinition = {
    id: "test.static",
    priority: 100,
    selectors: { names: ["web"] },
    declareEndpoints: () =>
      Effect.sync(() => {
        declarations++;
        return {};
      }),
    apply: () => Effect.void,
  };
  const result = await resolve(
    {
      missing: { type: "availability", environment: { FAIL: "yes" } },
      web: { type: "availability" },
      other: { type: "availability" },
    },
    { app },
  );
  expect(declarations).toBe(0);
  expect(result.resolution.endpointProjection.services.get("web")?.contributions._tag).toBe("Unavailable");
  expect(result.resolution.endpointProjection.services.get("other")?.contributions).toEqual({
    _tag: "Available",
    value: [],
  });
});

test("app definition load failure makes every potential contribution unavailable", async () => {
  const app: AppFeatureDefinition = { id: "test.failed-load", priority: 100, apply: () => Effect.void };
  const result = await resolve(
    { web: { type: "availability" }, worker: { type: "availability" } },
    { app, failAppLoad: true },
  );
  for (const row of result.resolution.endpointProjection.services.values()) {
    expect(row.preparation._tag).toBe("Available");
    expect(row.contributions._tag).toBe("Unavailable");
    expect(row.endpoints._tag).toBe("Unavailable");
  }
  if (result._tag === "Invalid") expect(result.issues).toHaveLength(1);
});

test("incomplete facts never invoke dynamic app declarations with a partial context", async () => {
  let declarations = 0;
  const app: AppFeatureDefinition = {
    id: "test.dynamic",
    priority: 100,
    selectors: { fromConfig: '{{ ["web"] }}' },
    declareEndpoints: () =>
      Effect.sync(() => {
        declarations++;
        return {};
      }),
    apply: () => Effect.void,
  };
  const result = await resolve(
    {
      missing: { type: "availability", environment: { FAIL: "yes" } },
      web: { type: "availability" },
      other: { type: "availability" },
    },
    { app },
  );
  expect(declarations).toBe(0);
  for (const name of ["web", "other"]) {
    const contributions = result.resolution.endpointProjection.services.get(name)?.contributions;
    expect(contributions?._tag).toBe("Unavailable");
    if (contributions?._tag === "Unavailable")
      expect(contributions.reasons.map((reason) => reason.path)).toEqual([["services", "missing", "port"]]);
  }
});

test.each([false, true])(
  "lint defers invalid app schema for nondeclaring or inactive features: %s",
  async (inactive) => {
    const app: AppFeatureDefinition = {
      id: "test.deferred",
      priority: 100,
      selectors: { names: ["web"] },
      ...(inactive
        ? { activatedBy: { services: { type: "missing" } }, declareEndpoints: () => Effect.succeed({}) }
        : {}),
      schema: Schema.Struct({ required: Schema.String }),
      apply: () => Effect.void,
    };
    const result = await resolve({ web: { type: "availability" } }, { app });
    expect(result._tag).toBe("Resolved");
    expect(result.resolution.endpointProjection.services.get("web")?.endpoints).toEqual({
      _tag: "Available",
      value: [],
    });
  },
);

test("independent app declaration errors aggregate without suppressing a successful declaration", async () => {
  const apps: AppFeatureDefinition[] = ["first", "second"].map((id) => ({
    id: `test.${id}`,
    priority: 100,
    selectors: { names: ["web"] },
    schema: Schema.Struct({ required: Schema.String }),
    declareEndpoints: () => Effect.succeed({}),
    apply: () => Effect.void,
  }));
  apps.push({
    id: "test.success",
    priority: 200,
    selectors: { names: ["worker"] },
    declareEndpoints: () => Effect.succeed({ worker: [{ _tag: "internal", protocol: "http", port: 8123 }] }),
    apply: () => Effect.void,
  });
  const result = await resolve(
    { web: { type: "availability" }, worker: { type: "availability", routes: ["worker.lndo.site"] } },
    { apps },
  );
  expect(result._tag).toBe("Invalid");
  if (result._tag === "Invalid")
    expect(result.issues.map((issue) => issue.rule)).toEqual(["landofile.service", "landofile.service"]);
  const rows = result.resolution.endpointProjection.services;
  const failed = rows.get("web")?.contributions;
  expect(failed?._tag).toBe("Unavailable");
  if (failed?._tag === "Unavailable") expect(failed.reasons).toHaveLength(2);
  expect(rows.get("worker")?.endpoints).toEqual({
    _tag: "Available",
    value: [{ _tag: "internal", protocol: "http", port: 8123 }],
  });
});
