import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { AppPlanner, PluginRegistry } from "@lando/core/services";
import { AppPlan, LandofileShape, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

import { AppPlannerLive, PluginRegistryLive } from "@lando/core/testing";
import { globalServices, services } from "../src/index.ts";
import { firstEndpointPort } from "./support/endpoint.ts";

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
  architectureEmulation: true,
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
      "dotnet",
      "dotnet:8.0",
      "dotnet:9.0",
      "elasticsearch",
      "elasticsearch:8",
      "go:1.22",
      "go:1.23",
      "lando",
      "localstack",
      "mailhog",
      "mailpit",
      "mariadb",
      "meilisearch",
      "meilisearch:1",
      "memcached",
      "minio",
      "mongodb",
      "mssql",
      "mssql:2019",
      "mssql:2022",
      "mysql",
      "nginx",
      "node:lts",
      "node:22",
      "opensearch",
      "opensearch:2",
      "php:8.1",
      "php:8.2",
      "php:8.3",
      "php:8.4",
      "php:8.5",
      "phpmyadmin",
      "phpmyadmin:5",
      "phpmyadmin:latest",
      "postgres",
      "python:3.12",
      "rabbitmq",
      "rabbitmq:3",
      "rabbitmq:4",
      "redis",
      "ruby:3.3",
      "solr",
      "solr:9",
      "static",
      "static:nginx",
      "static:caddy",
      "tomcat",
      "tomcat:9",
      "tomcat:10",
      "tomcat:11",
      "valkey",
      "varnish",
      "varnish:6",
      "varnish:7",
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

  test("AppPlanner composes RabbitMQ, MinIO, and LocalStack through PluginRegistry", async () => {
    // Given
    const landofile: LandofileShape = {
      name: "catalog-app",
      runtime: 4,
      services: {
        [ServiceName.make("queue")]: { type: "rabbitmq" },
        [ServiceName.make("object-store")]: { type: "minio", database: "uploads" },
        [ServiceName.make("aws")]: { type: "localstack" },
      },
    };

    // When
    const appPlan = await plan(landofile);
    const queue = appPlan.services[ServiceName.make("queue")];
    const objectStore = appPlan.services[ServiceName.make("object-store")];
    const aws = appPlan.services[ServiceName.make("aws")];
    if (queue === undefined || objectStore === undefined || aws === undefined) {
      throw new Error("catalog planner smoke services missing");
    }

    // Then
    expect(queue.artifact).toEqual({ kind: "ref", ref: "rabbitmq:4-management" });
    expect(
      queue.endpoints.flatMap((endpoint) => ("port" in endpoint ? [[endpoint.protocol, endpoint.port]] : [])),
    ).toEqual([
      ["tcp", 5672],
      ["http", 15672],
    ]);
    expect(queue.storage).toContainEqual({
      store: "catalog-app-rabbitmq-data",
      target: PortablePath.make("/var/lib/rabbitmq"),
      readOnly: false,
    });
    expect(queue.healthcheck?.command).toEqual(["rabbitmq-diagnostics", "-q", "ping"]);

    expect(objectStore.artifact).toEqual({ kind: "ref", ref: "minio/minio:latest" });
    expect(
      objectStore.endpoints.flatMap((endpoint) =>
        "port" in endpoint ? [[endpoint.protocol, endpoint.port]] : [],
      ),
    ).toEqual([
      ["tcp", 9000],
      ["http", 9001],
    ]);
    expect(objectStore.environment.MINIO_BUCKET).toBe("uploads");
    expect(objectStore.command).toEqual([
      "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9000 --console-address :9001",
    ]);
    expect(objectStore.storage).toContainEqual({
      store: "catalog-app-minio-data",
      target: PortablePath.make("/data"),
      readOnly: false,
    });
    expect(objectStore.healthcheck?.command).toEqual(["mc", "ready", "local"]);

    expect(aws.artifact).toEqual({ kind: "ref", ref: "localstack/localstack:4.14.0" });
    expect(
      aws.endpoints.flatMap((endpoint) => ("port" in endpoint ? [[endpoint.protocol, endpoint.port]] : [])),
    ).toEqual([["http", 4566]]);
    expect(aws.storage).toContainEqual({
      store: "catalog-app-localstack-data",
      target: PortablePath.make("/var/lib/localstack"),
      readOnly: false,
    });
    expect(aws.environment.GATEWAY_LISTEN).toBe("0.0.0.0:4566");
    expect(aws.healthcheck?.command).toEqual([
      "sh",
      "-c",
      "curl -sf http://localhost:4566/_localstack/health",
    ]);
  });

  test("AppPlanner composes app-scoped mailpit and mailhog without dropping global Mailpit", async () => {
    // Given
    const landofile: LandofileShape = {
      name: "mail-app",
      runtime: 4,
      services: {
        [ServiceName.make("inbox")]: { type: "mailpit" },
        [ServiceName.make("legacy")]: { type: "mailhog" },
      },
    };

    // When
    const appPlan = await plan(landofile);
    const inbox = appPlan.services[ServiceName.make("inbox")];
    const legacy = appPlan.services[ServiceName.make("legacy")];
    if (inbox === undefined || legacy === undefined) {
      throw new Error("mail planner smoke services missing");
    }

    // Then
    expect(globalServices.has("mailpit")).toBe(true);
    expect(inbox.type).toBe("mailpit");
    expect(inbox.artifact).toEqual({ kind: "ref", ref: "docker.io/axllent/mailpit:v1.30.1" });
    expect(
      inbox.endpoints.flatMap((endpoint) => ("port" in endpoint ? [[endpoint.protocol, endpoint.port]] : [])),
    ).toEqual([
      ["tcp", 1025],
      ["http", 8025],
    ]);
    expect(legacy.type).toBe("mailhog");
    expect(legacy.artifact).toEqual({ kind: "ref", ref: "mailhog/mailhog:v1.0.1" });
  });

  test("PluginRegistry loads tooling for every new service type id", async () => {
    // Given
    const cases = [
      ["localstack", ["awslocal"]],
      ["minio", ["mc"]],
      ["mssql", ["sqlcmd"]],
      ["mssql:2019", ["sqlcmd"]],
      ["mssql:2022", ["sqlcmd"]],
      ["rabbitmq", ["rabbitmqctl", "rabbitmqadmin"]],
      ["rabbitmq:3", ["rabbitmqctl", "rabbitmqadmin"]],
      ["rabbitmq:4", ["rabbitmqctl", "rabbitmqadmin"]],
    ] as const;

    for (const [id, expectedTooling] of cases) {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "tooling-app",
        runtime: 4,
        services: { service: { type: id } },
      });
      const service = landofile.services?.[ServiceName.make("service")];
      if (service === undefined) throw new Error(`${id} service missing from tooling fixture`);

      // When
      const resolution = await Effect.runPromise(
        Effect.flatMap(PluginRegistry, (registry) =>
          Effect.flatMap(registry.loadServiceType(id), (serviceType) =>
            serviceType.resolve({
              name: "service",
              service,
              appName: "tooling-app",
              appRoot: "/srv/apps/tooling-app",
              provider: ProviderId.make("lando"),
              primary: true,
              metadata: {
                resolvedAt: "2026-05-18T08:00:00Z",
                source: "@lando/service-lando/test/registration",
                runtime: 4,
              },
              capabilities: providerCapabilities,
            }),
          ),
        ).pipe(Effect.provide(registryLayer)),
      );

      // Then
      expect(Object.keys(resolution.tooling ?? {})).toEqual([...expectedTooling]);
    }
  });

  test("AppPlanner composes dotnet defaults through PluginRegistry", async () => {
    // Given
    const landofile: LandofileShape = {
      name: "dotnet-app",
      runtime: 4,
      services: { [ServiceName.make("api")]: { type: "dotnet", certs: false } },
    };

    // When
    const appPlan = await plan(landofile);
    const api = appPlan.services[ServiceName.make("api")];
    if (api === undefined) throw new Error("dotnet planner service missing");

    // Then
    expect(appPlan.routes[0]).toMatchObject({
      hostname: "api.dotnet-app.lndo.site",
      backend: { service: ServiceName.make("api"), protocol: "http", port: 5000 },
    });
    expect(api.storage).toContainEqual({
      store: "lando-cache-nuget",
      target: PortablePath.make("/root/.nuget/packages"),
      readOnly: false,
    });
    expect(appPlan.stores).toContainEqual({
      name: "lando-cache-nuget",
      scope: "global",
      kind: "cache",
      key: "nuget",
    });
    expect(api.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
  });

  test("AppPlanner composes mssql environment, storage, and healthcheck through PluginRegistry", async () => {
    // Given
    const landofile: LandofileShape = {
      name: "sql-app",
      runtime: 4,
      services: { [ServiceName.make("database")]: { type: "mssql" } },
    };

    // When
    const appPlan = await plan(landofile);
    const database = appPlan.services[ServiceName.make("database")];
    if (database === undefined) throw new Error("mssql planner service missing");

    // Then
    expect(database.environment).toMatchObject({ ACCEPT_EULA: "Y", MSSQL_PID: "Developer" });
    const saPassword = database.environment.SA_PASSWORD;
    if (saPassword === undefined) throw new Error("mssql SA_PASSWORD missing");
    expect(saPassword).toStartWith("Lando!");
    expect(database.storage).toContainEqual({
      store: "sql-app-mssql-data",
      target: PortablePath.make("/var/opt/mssql"),
      readOnly: false,
    });
    expect(database.healthcheck?.command).toEqual([
      "/opt/mssql-tools18/bin/sqlcmd",
      "-S",
      "localhost",
      "-U",
      "sa",
      "-P",
      saPassword,
      "-C",
      "-Q",
      "SELECT 1",
    ]);
  });

  for (const phpmyadminType of ["phpmyadmin", "phpmyadmin:5", "phpmyadmin:latest"] as const) {
    test(`AppPlanner auto-wires ${phpmyadminType} to a mysql sibling`, async () => {
      // Given
      const landofile: LandofileShape = {
        name: "pma-app",
        runtime: 4,
        services: {
          [ServiceName.make("pma")]: { type: phpmyadminType, certs: false },
          [ServiceName.make("database")]: {
            type: "mysql",
            healthcheck: { kind: "command", command: ["mysqladmin", "ping"] },
          },
        },
      };

      // When
      const appPlan = await plan(landofile);
      const pma = appPlan.services[ServiceName.make("pma")];
      if (pma === undefined) throw new Error("phpmyadmin planner service missing");

      // Then
      expect(pma.environment).toMatchObject({
        PMA_HOSTS: "database",
        PMA_USER: "lando",
        PMA_PASSWORD: "lando",
      });
      expect(pma.dependsOn).toContainEqual({
        service: ServiceName.make("database"),
        condition: "service_healthy",
        required: true,
      });
    });
  }

  test("AppPlanner honors phpmyadmin hosts overrides without a database sibling", async () => {
    // Given
    const landofile: LandofileShape = {
      name: "pma-remote-app",
      runtime: 4,
      services: {
        [ServiceName.make("pma")]: {
          type: "phpmyadmin",
          hosts: ["db-a", "db-b"],
          certs: false,
        },
      },
    };

    // When
    const appPlan = await plan(landofile);
    const pma = appPlan.services[ServiceName.make("pma")];
    if (pma === undefined) throw new Error("phpmyadmin planner service missing");

    // Then
    expect(pma.environment.PMA_HOSTS).toBe("db-a,db-b");
    expect(pma.dependsOn).toEqual([]);
  });

  test("AppPlanner fails when phpmyadmin has neither hosts nor a database sibling", async () => {
    // Given
    const landofile: LandofileShape = {
      name: "pma-bad-app",
      runtime: 4,
      services: { [ServiceName.make("pma")]: { type: "phpmyadmin", certs: false } },
    };

    // When / Then
    await expect(plan(landofile)).rejects.toThrow(/no mysql\/mariadb siblings and no hosts/);
  });

  test("AppPlanner resolves php:8.2 and php:8.3 through PluginRegistry with explicit webroots", async () => {
    const appPlan = await plan({
      name: "php-app",
      runtime: 4,
      services: {
        [ServiceName.make("web")]: { type: "php:8.2", webroot: PortablePath.make("/app/web") },
        [ServiceName.make("api")]: { type: "php:8.3", webroot: PortablePath.make("/app/public") },
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
    expect(firstEndpointPort(web)).toBe(8000);

    expect(api.type).toBe("python:3.12");
    expect(api.environment.FLASK_APP).toBe("app");
    expect(api.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/5000"]);
    expect(firstEndpointPort(api)).toBe(5000);
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
    expect(firstEndpointPort(web)).toBe(3000);

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
    expect(firstEndpointPort(web)).toBe(8080);
    expect(web.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);

    expect(api.type).toBe("go:1.23");
    expect(api.environment.LANDO_SERVICE_TYPE).toBe("go:1.23");
    expect(firstEndpointPort(api)).toBe(8080);
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

  test("AppPlanner composes Tomcat and Varnish through PluginRegistry", async () => {
    const landofile: LandofileShape = {
      name: "catalog-app",
      runtime: 4,
      services: {
        [ServiceName.make("appserver")]: { type: "nginx" },
        [ServiceName.make("java")]: { type: "tomcat", certs: false },
        [ServiceName.make("cache")]: { type: "varnish", backend: "appserver", certs: false },
      },
    };

    const appPlan = await plan(landofile);
    const java = appPlan.services[ServiceName.make("java")];
    const cache = appPlan.services[ServiceName.make("cache")];
    if (java === undefined || cache === undefined) {
      throw new Error("tomcat/varnish planner smoke services missing");
    }

    expect(java.artifact).toEqual({ kind: "ref", ref: "tomcat:11-jre21" });
    expect(java.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);
    expect(cache.artifact).toEqual({ kind: "ref", ref: "varnish:7" });
    expect(cache.healthcheck?.command).toEqual(["varnishadm", "ping"]);
    expect(cache.dependsOn).toEqual([
      { service: ServiceName.make("appserver"), condition: "service_healthy", required: true },
    ]);
  });

  test("AppPlanner wires nginx FastCGI to the PHP FPM service's authored port", async () => {
    const landofile: LandofileShape = {
      name: "php-fpm-nginx",
      runtime: 4,
      services: {
        [ServiceName.make("appserver")]: { type: "php:8.3", via: "fpm", port: 9070 },
        [ServiceName.make("edge")]: { type: "nginx", backend: "appserver" },
      },
    };

    const appPlan = await plan(landofile);
    const appserver = appPlan.services[ServiceName.make("appserver")];
    const edge = appPlan.services[ServiceName.make("edge")];
    if (appserver === undefined || edge === undefined) {
      throw new Error("php-fpm/nginx planner services missing");
    }

    const command = Array.isArray(edge.command)
      ? edge.command.join(" ")
      : typeof edge.command === "string"
        ? edge.command
        : "";
    expect(command).toContain("fastcgi_pass appserver:9070");
    expect(appserver.command?.[2]).toContain("listen = 9070");
  });

  test("AppPlanner fails closed when Varnish backend is unknown", async () => {
    const landofile: LandofileShape = {
      name: "catalog-app",
      runtime: 4,
      services: {
        [ServiceName.make("cache")]: { type: "varnish", backend: "missing", certs: false },
      },
    };

    await expect(plan(landofile)).rejects.toThrow(/missing service missing.*service_healthy/);
  });
});
