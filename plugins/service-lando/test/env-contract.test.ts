import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeHostFacts } from "@lando/sdk/services";

import { appMountTarget } from "../src/services/_volume-helpers.ts";
import { apacheServiceType } from "../src/services/apache.ts";
import { composeServiceType } from "../src/services/compose.ts";
import { dotnetServiceType } from "../src/services/dotnet.ts";
import { elasticsearchServiceType } from "../src/services/elasticsearch.ts";
import { go122ServiceType, go123ServiceType } from "../src/services/go.ts";
import { landoServiceType } from "../src/services/lando.ts";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { meilisearchServiceType } from "../src/services/meilisearch.ts";
import { memcachedServiceType } from "../src/services/memcached.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { nginxServiceType } from "../src/services/nginx.ts";
import { node22ServiceType, nodeLtsServiceType } from "../src/services/node.ts";
import { opensearchServiceType } from "../src/services/opensearch.ts";
import { php82ServiceType, php83ServiceType } from "../src/services/php.ts";
import { postgresServiceType } from "../src/services/postgres.ts";
import { python312ServiceType } from "../src/services/python.ts";
import { redisServiceType } from "../src/services/redis.ts";
import { ruby33ServiceType } from "../src/services/ruby.ts";
import { solrServiceType } from "../src/services/solr.ts";
import { staticCaddyServiceType, staticNginxServiceType } from "../src/services/static.ts";
import { valkeyServiceType } from "../src/services/valkey.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const host: ServiceTypeHostFacts = {
  os: "linux",
  user: "lando-user",
  uid: "1000",
  gid: "1000",
  home: "/home/lando-user",
  arch: "x64",
};

describe("effective app mount paths", () => {
  test.each([
    [undefined, "/app"],
    [false, "/app"],
    [{ target: "/site/" }, "/site"],
    [{ target: "/other/../site" }, "/site"],
  ] as const)("normalizes app mount %j to %s", (authored, expected) => {
    // Given: a decoded service with an optional app mount.
    const config = Schema.decodeUnknownSync(LandofileShape)({
      services: { web: { type: "apache", ...(authored === undefined ? {} : { appMount: authored }) } },
    });
    const service = config.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");
    // When: the mount target is derived.
    const target = appMountTarget(service.appMount);
    // Then: defaults and disabled mounts retain /app, while authored targets are normalized.
    expect(String(target)).toBe(expected);
  });

  const mountCases = [
    { type: "php:8.2", serviceType: php82ServiceType, webroot: "public", cwd: "/site/public" },
    { type: "nginx", serviceType: nginxServiceType, webroot: "public", cwd: "/site/public" },
    { type: "apache", serviceType: apacheServiceType },
    { type: "static:nginx", serviceType: staticNginxServiceType },
    { type: "static:caddy", serviceType: staticCaddyServiceType },
    { type: "node:22", serviceType: node22ServiceType },
    { type: "lando", serviceType: landoServiceType, image: "alpine:3" },
    { type: "python:3.12", serviceType: python312ServiceType },
    { type: "ruby:3.3", serviceType: ruby33ServiceType },
    { type: "ruby:3.3", serviceType: ruby33ServiceType, framework: "rails", expectedWebroot: "/site/public" },
    { type: "go:1.22", serviceType: go122ServiceType },
    { type: "dotnet", serviceType: dotnetServiceType, expectsAppPaths: false },
    {
      type: "compose",
      serviceType: composeServiceType,
      image: "alpine:3",
      expectsAppPaths: false,
      cwd: undefined,
    },
  ] satisfies ReadonlyArray<{
    readonly type: string;
    readonly serviceType: ServiceType;
    readonly image?: string;
    readonly framework?: string;
    readonly webroot?: string;
    readonly expectedWebroot?: string;
    readonly expectsAppPaths?: boolean;
    readonly cwd?: string | undefined;
  }>;

  for (const entry of mountCases) {
    test(`${entry.type} ${"framework" in entry ? entry.framework : ""} follows a moved app mount`, async () => {
      // Given: an app mount with a trailing slash and an optional framework/webroot.
      const { serviceType } = entry;
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: {
          web: {
            type: entry.type,
            appMount: { target: "/site/" },
            ...("image" in entry ? { image: entry.image } : {}),
            ...("framework" in entry ? { framework: entry.framework } : {}),
            ...("webroot" in entry ? { webroot: entry.webroot } : {}),
          },
        },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      // When: the service is composed through the real service features and authored wrapper.
      const plan = await composeServicePlan({ serviceType, service, appRoot: "/srv/apps/myapp", metadata });
      // Then: the app has one bind at the effective target, with matching env and default cwd.
      expect(String(plan.appMount?.target)).toBe("/site");
      expect(plan.mounts.filter((mount) => mount.type === "bind" && mount.target === "/site")).toHaveLength(
        1,
      );
      expect(plan.mounts.filter((mount) => mount.type === "bind" && mount.target === "/app")).toHaveLength(0);
      expect(plan.workingDirectory === undefined ? undefined : String(plan.workingDirectory)).toBe(
        "cwd" in entry ? entry.cwd : "/site",
      );
      if (!("expectsAppPaths" in entry)) {
        expect(plan.environment.LANDO_APP_ROOT).toBe("/site");
        expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/site");
      }
      if (entry.expectedWebroot !== undefined) {
        expect(plan.environment.LANDO_WEBROOT).toBe(entry.expectedWebroot);
      }
    });
  }

  test("an authored working directory wins over the moved mount", async () => {
    // Given: a mount and working directory with different paths.
    const config = Schema.decodeUnknownSync(LandofileShape)({
      services: { web: { type: "apache", appMount: { target: "/site" }, workingDirectory: "/work" } },
    });
    const service = config.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");
    // When: the service is composed.
    const plan = await composeServicePlan({
      serviceType: apacheServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });
    // Then: the authored working directory wins without changing the app paths.
    expect(String(plan.workingDirectory)).toBe("/work");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/site");
  });

  for (const serviceType of [php82ServiceType, composeServiceType]) {
    test(`${serviceType.id} lets an authored mount replace the moved app bind`, async () => {
      // Given: an authored bind at the effective app target.
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: {
          web: {
            type: serviceType.id,
            image: "alpine:3",
            appMount: { target: "/site/" },
            mounts: ["./alternate:/site"],
          },
        },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      // When: the service is composed.
      const plan = await composeServicePlan({ serviceType, service, appRoot: "/srv/apps/myapp", metadata });
      // Then: only the authored bind occupies the target.
      expect(plan.mounts.filter((mount) => mount.target === "/site")).toMatchObject([
        { type: "bind", source: "/srv/apps/myapp/alternate" },
      ]);
      expect(plan.mounts.some((mount) => mount.target === "/app")).toBe(false);
    });
  }

  test("compose volumes do not duplicate a normalized app mount target", async () => {
    // Given: a Compose volume targeting the normalized app bind.
    const config = Schema.decodeUnknownSync(LandofileShape)({
      services: {
        web: {
          type: "compose",
          image: "alpine:3",
          appMount: { target: "/site/" },
          volumes: ["./alternate:/site"],
        },
      },
    });
    const service = config.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");
    // When: the service is composed.
    const plan = await composeServicePlan({
      serviceType: composeServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });
    // Then: the app bind wins over the Compose volume.
    expect(plan.mounts.filter((mount) => mount.target === "/site")).toMatchObject([
      { type: "bind", source: "/srv/apps/myapp" },
    ]);
  });
});

interface CatalogCase {
  readonly id: string;
  readonly serviceType: ServiceType;
  readonly landofileService: Record<string, unknown>;
  readonly expectedType: string;
  readonly expectsAppPaths: boolean;
  readonly expectsWebroot: string | null;
}

const cases: ReadonlyArray<CatalogCase> = [
  {
    id: "apache",
    serviceType: apacheServiceType,
    landofileService: { type: "apache" },
    expectedType: "apache",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "nginx",
    serviceType: nginxServiceType,
    landofileService: { type: "nginx" },
    expectedType: "nginx",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "go:1.22",
    serviceType: go122ServiceType,
    landofileService: { type: "go:1.22" },
    expectedType: "go:1.22",
    expectsAppPaths: true,
    expectsWebroot: null,
  },
  {
    id: "go:1.23",
    serviceType: go123ServiceType,
    landofileService: { type: "go:1.23" },
    expectedType: "go:1.23",
    expectsAppPaths: true,
    expectsWebroot: null,
  },
  {
    id: "node:lts",
    serviceType: nodeLtsServiceType,
    landofileService: { type: "node:lts" },
    expectedType: "node:lts",
    expectsAppPaths: true,
    expectsWebroot: null,
  },
  {
    id: "node:22",
    serviceType: node22ServiceType,
    landofileService: { type: "node:22" },
    expectedType: "node:22",
    expectsAppPaths: true,
    expectsWebroot: null,
  },
  {
    id: "php:8.2",
    serviceType: php82ServiceType,
    landofileService: { type: "php:8.2" },
    expectedType: "php:8.2",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "php:8.3",
    serviceType: php83ServiceType,
    landofileService: { type: "php:8.3" },
    expectedType: "php:8.3",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "python:3.12",
    serviceType: python312ServiceType,
    landofileService: { type: "python:3.12" },
    expectedType: "python:3.12",
    expectsAppPaths: true,
    expectsWebroot: null,
  },
  {
    id: "ruby:3.3",
    serviceType: ruby33ServiceType,
    landofileService: { type: "ruby:3.3" },
    expectedType: "ruby:3.3",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "static:nginx",
    serviceType: staticNginxServiceType,
    landofileService: { type: "static:nginx" },
    expectedType: "static:nginx",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "static:caddy",
    serviceType: staticCaddyServiceType,
    landofileService: { type: "static:caddy" },
    expectedType: "static:caddy",
    expectsAppPaths: true,
    expectsWebroot: "/app",
  },
  {
    id: "mariadb",
    serviceType: mariadbServiceType,
    landofileService: { type: "mariadb" },
    expectedType: "mariadb",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "mysql",
    serviceType: mysqlServiceType,
    landofileService: { type: "mysql" },
    expectedType: "mysql",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "postgres",
    serviceType: postgresServiceType,
    landofileService: { type: "postgres" },
    expectedType: "postgres",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "redis",
    serviceType: redisServiceType,
    landofileService: { type: "redis" },
    expectedType: "redis",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "memcached",
    serviceType: memcachedServiceType,
    landofileService: { type: "memcached" },
    expectedType: "memcached",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "valkey",
    serviceType: valkeyServiceType,
    landofileService: { type: "valkey" },
    expectedType: "valkey",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "elasticsearch",
    serviceType: elasticsearchServiceType,
    landofileService: { type: "elasticsearch" },
    expectedType: "elasticsearch",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "opensearch",
    serviceType: opensearchServiceType,
    landofileService: { type: "opensearch" },
    expectedType: "opensearch",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "meilisearch",
    serviceType: meilisearchServiceType,
    landofileService: { type: "meilisearch" },
    expectedType: "meilisearch",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "solr",
    serviceType: solrServiceType,
    landofileService: { type: "solr" },
    expectedType: "solr",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
  {
    id: "compose",
    serviceType: composeServiceType,
    landofileService: { type: "compose", image: "busybox" },
    expectedType: "compose",
    expectsAppPaths: false,
    expectsWebroot: null,
  },
];

const landoEnvKeys = (environment: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.keys(environment).filter((key) => key === "LANDO" || key.startsWith("LANDO_"));

const planFor = async (item: CatalogCase, serviceName: string, appName: string) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: appName,
    services: { [serviceName]: item.landofileService },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${item.id} service missing from landofile fixture`);
  return composeServicePlan({
    serviceType: item.serviceType,
    service,
    appRoot: "/srv/apps/myapp",
    appName,
    serviceName,
    metadata,
    host,
  });
};

describe("LANDO_* environment contract across catalog service families", () => {
  for (const item of cases) {
    test(`${item.id} emits the basic LANDO_* identity, host, and (where applicable) app-path env`, async () => {
      const serviceName = item.id === "compose" ? "worker" : "web";
      const plan = await planFor(item, serviceName, "myapp");

      if (item.id === "compose") {
        expect(landoEnvKeys(plan.environment)).toEqual([]);
        expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
        return;
      }

      expect(plan.environment.LANDO).toBe("ON");
      expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
      expect(plan.environment.LANDO_APP_KIND).toBe("user");
      expect(plan.environment.LANDO_PROJECT).toBe("myapp");
      expect(plan.environment.LANDO_SERVICE_API).toBe("4");
      expect(plan.environment.LANDO_SERVICE_NAME).toBe(serviceName);
      expect(plan.environment.LANDO_SERVICE_TYPE).toBe(item.expectedType);
      expect(plan.environment.LANDO_MAIL_HOST).toBe("mailpit.global.internal");
      expect(plan.environment.LANDO_MAIL_PORT).toBe("1025");

      expect(plan.environment.LANDO_HOST_OS).toBe(host.os);
      expect(plan.environment.LANDO_HOST_USER).toBe(host.user);
      expect(plan.environment.LANDO_HOST_UID).toBe(host.uid);
      expect(plan.environment.LANDO_HOST_GID).toBe(host.gid);
      expect(plan.environment.LANDO_HOST_HOME).toBe(host.home);

      if (item.expectsAppPaths) {
        expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
        expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
      } else {
        expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
        expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
      }

      if (item.expectsWebroot !== null) {
        expect(plan.environment.LANDO_WEBROOT).toBe(item.expectsWebroot);
      }
    });

    test(`${item.id} marks global-app services and does not project global Mailpit env`, async () => {
      const serviceName = item.id === "compose" ? "mailpit" : "web";
      const plan = await planFor(item, serviceName, "global");

      if (item.id === "compose") {
        expect(landoEnvKeys(plan.environment)).toEqual([]);
        return;
      }

      expect(plan.environment.LANDO_APP_KIND).toBe("global");
      expect(plan.environment.LANDO_MAIL_HOST).toBeUndefined();
      expect(plan.environment.LANDO_MAIL_PORT).toBeUndefined();
    });

    test(`${item.id} rejects user environment that collides with reserved LANDO_* keys`, async () => {
      const serviceName = item.id === "compose" ? "worker" : "web";
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: {
          [serviceName]: {
            ...item.landofileService,
            environment: { LANDO_PROJECT: "fake" },
          },
        },
      });
      const service = landofile.services?.[ServiceName.make(serviceName)];
      if (service === undefined) throw new Error("service missing");

      const planPromise = composeServicePlan({
        serviceType: item.serviceType,
        service,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        serviceName,
        metadata,
        host,
      });

      if (item.id === "compose") {
        return expect(planPromise).resolves.toMatchObject({ environment: { LANDO_PROJECT: "fake" } });
      }

      return expect(planPromise).rejects.toThrow(/reserved LANDO_\* keys.*LANDO_PROJECT/);
    });

    test(`${item.id} slugifies app names with whitespace into LANDO_PROJECT`, async () => {
      const serviceName = item.id === "compose" ? "worker" : "web";
      const plan = await planFor(item, serviceName, "My App");

      if (item.id === "compose") {
        expect(landoEnvKeys(plan.environment)).toEqual([]);
        return;
      }

      expect(plan.environment.LANDO_APP_NAME).toBe("My App");
      expect(plan.environment.LANDO_PROJECT).toBe("my-app");
    });

    test(`${item.id} omits LANDO_HOST_* when planner did not supply host facts`, async () => {
      const serviceName = item.id === "compose" ? "worker" : "web";
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { [serviceName]: item.landofileService },
      });
      const service = landofile.services?.[ServiceName.make(serviceName)];
      if (service === undefined) throw new Error("service missing");
      const plan = await composeServicePlan({
        serviceType: item.serviceType,
        service,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        serviceName,
        metadata,
      });
      expect(plan.environment.LANDO_HOST_OS).toBeUndefined();
      expect(plan.environment.LANDO_HOST_USER).toBeUndefined();
      expect(plan.environment.LANDO_HOST_UID).toBeUndefined();
      expect(plan.environment.LANDO_HOST_GID).toBeUndefined();
      expect(plan.environment.LANDO_HOST_HOME).toBeUndefined();
    });
  }
});
