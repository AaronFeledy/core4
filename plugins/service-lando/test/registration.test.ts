import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { AppPlanner, PluginRegistry } from "@lando/core/services";
import { AppPlan, type LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";

import { PluginRegistryLive } from "../../../core/src/plugins/registry.ts";
import { AppPlannerLive } from "../../../core/src/services/planner.ts";
import { services } from "../src/index.ts";

const providerCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
} as const;

const registryLayer = Layer.merge(services, PluginRegistryLive);

const plan = (landofile: LandofileShape) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(registryLayer),
    ),
  );

describe("@lando/service-lando registration", () => {
  test("loads both service type contributions from PluginRegistry", async () => {
    const manifest = await Effect.runPromise(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@lando/service-lando")).pipe(
        Effect.provide(registryLayer),
      ),
    );

    if (manifest.contributes === undefined) throw new Error("service-lando manifest contributions missing");
    expect(manifest.contributes.serviceTypes).toEqual([
      "apache",
      "compose",
      "elasticsearch",
      "elasticsearch:8",
      "go:1.22",
      "go:1.23",
      "lando",
      "mariadb",
      "meilisearch",
      "meilisearch:1",
      "memcached",
      "mongodb",
      "mysql",
      "nginx",
      "node:lts",
      "node:22",
      "opensearch",
      "opensearch:2",
      "postgres",
      "php:8.1",
      "php:8.2",
      "php:8.3",
      "php:8.4",
      "python:3.12",
      "redis",
      "ruby:3.3",
      "solr",
      "solr:9",
      "static",
      "static:nginx",
      "static:caddy",
      "valkey",
    ]);
  });

  test("AppPlanner resolves both service types through PluginRegistry", async () => {
    const appPlan = await plan({
      name: "registry-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "node:lts" },
        [ServiceName.make("db")]: { type: "postgres" },
      },
    });

    const encoded = Schema.encodeSync(AppPlan)(appPlan);
    expect(Schema.decodeUnknownEither(AppPlan)(encoded)._tag).toBe("Right");
    expect(appPlan.provider).toBe(ProviderId.make("lando"));
    expect(appPlan.services[ServiceName.make("web")]?.type).toBe("node:lts");
    expect(appPlan.services[ServiceName.make("db")]?.type).toBe("postgres");
  });

  test("AppPlanner resolves php:8.2 and php:8.3 through PluginRegistry with explicit webroots", async () => {
    const appPlan = await plan({
      name: "php-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "php:8.2", webroot: "/app/web" },
        [ServiceName.make("api")]: { type: "php:8.3", webroot: "/app/public" },
      },
    });

    const web = appPlan.services[ServiceName.make("web")];
    const api = appPlan.services[ServiceName.make("api")];
    if (web === undefined || api === undefined) throw new Error("php services missing");

    expect(web.type).toBe("php:8.2");
    expect(String(web.workingDirectory)).toBe("/app/web");
    expect(web.environment.LANDO_APP_NAME).toBe("php-app");
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("php:8.2");
    expect(web.environment.LANDO_WEBROOT).toBe("/app/web");
    expect(web.healthcheck?.kind).toBe("command");
    expect(web.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/80"]);

    expect(api.type).toBe("php:8.3");
    expect(String(api.workingDirectory)).toBe("/app/public");
    expect(api.environment.LANDO_SERVICE_TYPE).toBe("php:8.3");
    expect(api.environment.LANDO_WEBROOT).toBe("/app/public");
  });

  test("AppPlanner resolves python:3.12 through PluginRegistry with framework presets", async () => {
    const appPlan = await plan({
      name: "py-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "python:3.12", framework: "django" },
        [ServiceName.make("api")]: { type: "python:3.12", framework: "flask" },
      },
    });

    const web = appPlan.services[ServiceName.make("web")];
    const api = appPlan.services[ServiceName.make("api")];
    if (web === undefined || api === undefined) throw new Error("python services missing");

    expect(web.type).toBe("python:3.12");
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("python:3.12");
    expect(web.environment.DJANGO_SETTINGS_MODULE).toBe("config.settings");
    expect(web.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8000"]);
    expect(web.endpoints[0]?.port).toBe(8000);

    expect(api.type).toBe("python:3.12");
    expect(api.environment.FLASK_APP).toBe("app");
    expect(api.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/5000"]);
    expect(api.endpoints[0]?.port).toBe(5000);
  });

  test("AppPlanner rejects unsupported python versions with Python-family remediation", async () => {
    await expect(
      plan({
        name: "py-bad",
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: "python:3.11" } },
      }),
    ).rejects.toThrow(/Unsupported service type python:3\.11.*Supported alternatives:.*python:3\.12/);
  });

  test("AppPlanner rejects unsupported php versions with PHP-family remediation", async () => {
    await expect(
      plan({
        name: "php-bad",
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: "php:9.0" } },
      }),
    ).rejects.toThrow(/Unsupported service type php:9\.0.*Supported alternatives:.*php:8\.1.*php:8\.4/);
  });

  test("AppPlanner resolves ruby:3.3 through PluginRegistry with rails framework preset", async () => {
    const appPlan = await plan({
      name: "rb-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "ruby:3.3", framework: "rails" },
        [ServiceName.make("api")]: { type: "ruby:3.3" },
      },
    });

    const web = appPlan.services[ServiceName.make("web")];
    const api = appPlan.services[ServiceName.make("api")];
    if (web === undefined || api === undefined) throw new Error("ruby services missing");

    expect(web.type).toBe("ruby:3.3");
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("ruby:3.3");
    expect(web.environment.RAILS_ENV).toBe("development");
    expect(web.environment.LANDO_WEBROOT).toBe("/app/public");
    expect(web.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3000"]);
    expect(web.endpoints[0]?.port).toBe(3000);

    expect(api.type).toBe("ruby:3.3");
    expect(api.environment.LANDO_WEBROOT).toBe("/app");
    expect(api.environment.RAILS_ENV).toBeUndefined();
    expect(api.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/3000"]);
  });

  test("AppPlanner rejects unsupported ruby versions with Ruby-family remediation", async () => {
    await expect(
      plan({
        name: "rb-bad",
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: "ruby:3.2" } },
      }),
    ).rejects.toThrow(/Unsupported service type ruby:3\.2.*Supported alternatives:.*ruby:3\.3/);
  });

  test("AppPlanner resolves go:1.22 and go:1.23 through PluginRegistry with framework=none defaults", async () => {
    const appPlan = await plan({
      name: "go-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "go:1.22" },
        [ServiceName.make("api")]: { type: "go:1.23" },
      },
    });

    const web = appPlan.services[ServiceName.make("web")];
    const api = appPlan.services[ServiceName.make("api")];
    if (web === undefined || api === undefined) throw new Error("go services missing");

    expect(web.type).toBe("go:1.22");
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("go:1.22");
    expect(web.environment.GOPATH).toBe("/go");
    expect(web.environment.GOCACHE).toBe("/root/.cache/go-build");
    expect(web.environment.CGO_ENABLED).toBe("0");
    expect(web.environment.LANDO_APP_ROOT).toBe("/app");
    expect(web.endpoints[0]?.port).toBe(8080);
    expect(web.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);

    expect(api.type).toBe("go:1.23");
    expect(api.environment.LANDO_SERVICE_TYPE).toBe("go:1.23");
    expect(api.endpoints[0]?.port).toBe(8080);
  });

  test("AppPlanner rejects unsupported Go versions with Go-family remediation", async () => {
    await expect(
      plan({
        name: "go-bad",
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: "go:1.21" } },
      }),
    ).rejects.toThrow(/Unsupported service type go:1\.21.*Supported alternatives:.*go:1\.22.*go:1\.23/);
  });

  test("AppPlanner resolves explicit static:nginx through PluginRegistry as static:nginx alias", async () => {
    const appPlan = await plan({
      name: "static-app",
      runtime: 4,
      services: { [ServiceName.make("web")]: { type: "static:nginx" } },
    });

    const web = appPlan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("static service missing");
    expect(web.type).toBe("static:nginx");
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("static:nginx");
  });

  test("AppPlanner rejects unknown non-family service types with registered-types remediation", async () => {
    await expect(
      plan({
        name: "weird-app",
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: "totally-fake-type" } },
      }),
    ).rejects.toThrow(
      /Unsupported service type totally-fake-type.*Registered service types:.*node:22.*node:lts.*php:8\.1.*php:8\.4.*postgres.*python:3\.12.*ruby:3\.3/,
    );
  });
});
