import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { ListenerAuthority } from "@lando/sdk/schema";
import type { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType, ServiceTypeResolution } from "@lando/sdk/services";
import { serviceTypes } from "../src/index.ts";

import { imageAuthority, launcherAuthority } from "../src/services/_port-helpers.ts";
import { APACHE_LISTENER, apacheServiceFeature, apacheServiceType } from "../src/services/apache.ts";
import {
  MEMCACHED_LISTENER,
  memcachedServiceFeature,
  memcachedServiceType,
} from "../src/services/memcached.ts";
import { MINIO_LISTENER, minioServiceFeature, minioServiceType } from "../src/services/minio.ts";
import { MONGODB_LISTENER, mongodbServiceFeature, mongodbServiceType } from "../src/services/mongodb.ts";
import { NGINX_LISTENER, nginxServiceFeature, nginxServiceType } from "../src/services/nginx.ts";
import { PHP_LISTENERS } from "../src/services/php-via.ts";
import { php83ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { REDIS_LISTENER, redisServiceFeature, redisServiceType } from "../src/services/redis.ts";
import { SOLR_LISTENER, solrServiceFeature, solrServiceType } from "../src/services/solr.ts";
import {
  STATIC_LISTENERS,
  staticCaddyServiceType,
  staticNginxServiceType,
  staticServiceFeature,
} from "../src/services/static.ts";
import { TOMCAT_LISTENER, tomcatServiceFeature, tomcatServiceType } from "../src/services/tomcat.ts";
import { VALKEY_LISTENER, valkeyServiceFeature, valkeyServiceType } from "../src/services/valkey.ts";
import { VARNISH_LISTENER, varnishServiceFeature, varnishServiceType } from "../src/services/varnish.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const APP_ROOT = "/srv/apps/myapp";
const METADATA = {
  resolvedAt: "2026-11-01T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const CUSTOM_ENTRYPOINT = ["custom-start"] as const;
const CUSTOM_COMMAND = ["custom-command"] as const;

type AuthorityCase = {
  readonly id: string;
  readonly serviceType: ServiceType;
  readonly feature: ServiceFeatureDefinition;
  readonly service: ServiceConfig;
  /** Expected authority, or undefined when none is set. */
  readonly authority: ListenerAuthority | undefined;
  /** Extra assertions against recorded apply calls (beyond the authority). */
  readonly assertCalls?: (calls: readonly (readonly unknown[])[]) => void;
};

const resolveService = (serviceType: ServiceType, service: ServiceConfig): ServiceTypeResolution =>
  Effect.runSync(
    serviceType.resolve({
      name: "web",
      service,
      appRoot: APP_ROOT,
      metadata: METADATA,
    }),
  );

const applyFeature = (
  feature: ServiceFeatureDefinition,
  resolution: ServiceTypeResolution,
): {
  readonly calls: readonly (readonly unknown[])[];
  readonly authorities: readonly ListenerAuthority[];
} => {
  const featureRef = resolution.features.find((entry) => entry.id === feature.id);
  if (featureRef === undefined) throw new Error(`Missing resolved feature ${feature.id}`);
  const { ctx, calls } = recordFeatureContext({
    serviceType: resolution.normalizedConfig.type ?? feature.id,
    normalizedConfig: resolution.normalizedConfig,
    config: featureRef.config ?? {},
    connection: resolution.connection,
  });
  Effect.runSync(feature.apply(ctx));
  const authorities = calls
    .filter((call): call is ["setListenerAuthority", ListenerAuthority] => call[0] === "setListenerAuthority")
    .map((call) => call[1]);
  return { calls, authorities };
};

const cases: readonly AuthorityCase[] = [
  // --- mongodb: authority only when port or config AND authored process override ---
  {
    id: "mongodb port+command authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", port: 27018, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(MONGODB_LISTENER, 27018),
  },
  {
    id: "mongodb port+entrypoint authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", port: 27018, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: launcherAuthority(MONGODB_LISTENER, 27018),
  },
  {
    id: "mongodb config+command authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", config: { server: "config/mongod.conf" }, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(MONGODB_LISTENER, 27017),
  },
  {
    id: "mongodb config+entrypoint authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: {
      type: "mongodb",
      config: { server: "config/mongod.conf" },
      entrypoint: [...CUSTOM_ENTRYPOINT],
    },
    authority: launcherAuthority(MONGODB_LISTENER, 27017),
  },
  {
    id: "mongodb command-only without port/config omits authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", command: [...CUSTOM_COMMAND] },
    authority: undefined,
  },
  {
    id: "mongodb entrypoint-only without port/config omits authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: undefined,
  },
  {
    id: "mongodb stock port omits authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", port: 27018 },
    authority: undefined,
  },
  {
    id: "mongodb default stock omits authority",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb" },
    authority: undefined,
  },

  // --- redis: command authority; entrypoint-only preserves Lando argv / no authority ---
  {
    id: "redis command authority",
    serviceType: redisServiceType,
    feature: redisServiceFeature,
    service: { type: "redis", port: 16379, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(REDIS_LISTENER, 16379),
  },
  {
    id: "redis entrypoint-only omits authority",
    serviceType: redisServiceType,
    feature: redisServiceFeature,
    service: { type: "redis", port: 16379, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: undefined,
  },
  {
    id: "redis stock omits authority",
    serviceType: redisServiceType,
    feature: redisServiceFeature,
    service: { type: "redis", port: 16379 },
    authority: undefined,
  },

  // --- valkey ---
  {
    id: "valkey command authority",
    serviceType: valkeyServiceType,
    feature: valkeyServiceFeature,
    service: { type: "valkey", port: 6380, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(VALKEY_LISTENER, 6380),
  },
  {
    id: "valkey entrypoint-only omits authority",
    serviceType: valkeyServiceType,
    feature: valkeyServiceFeature,
    service: { type: "valkey", port: 6380, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: undefined,
  },
  {
    id: "valkey stock omits authority",
    serviceType: valkeyServiceType,
    feature: valkeyServiceFeature,
    service: { type: "valkey", port: 6380 },
    authority: undefined,
  },

  // --- memcached ---
  {
    id: "memcached command authority",
    serviceType: memcachedServiceType,
    feature: memcachedServiceFeature,
    service: { type: "memcached", port: 11212, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(MEMCACHED_LISTENER, 11212),
  },
  {
    id: "memcached entrypoint-only omits authority",
    serviceType: memcachedServiceType,
    feature: memcachedServiceFeature,
    service: { type: "memcached", port: 11212, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: undefined,
  },
  {
    id: "memcached stock omits authority",
    serviceType: memcachedServiceType,
    feature: memcachedServiceFeature,
    service: { type: "memcached", port: 11212 },
    authority: undefined,
  },

  // --- solr ---
  {
    id: "solr command authority",
    serviceType: solrServiceType,
    feature: solrServiceFeature,
    service: { type: "solr", port: 8984, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(SOLR_LISTENER, 8984),
  },
  {
    id: "solr entrypoint-only omits authority",
    serviceType: solrServiceType,
    feature: solrServiceFeature,
    service: { type: "solr", port: 8984, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: undefined,
  },
  {
    id: "solr stock omits authority",
    serviceType: solrServiceType,
    feature: solrServiceFeature,
    service: { type: "solr", port: 8984 },
    authority: undefined,
  },

  // --- minio: command authority; entrypoint-only keeps generated args / no authority ---
  {
    id: "minio command authority",
    serviceType: minioServiceType,
    feature: minioServiceFeature,
    service: {
      type: "minio",
      image: "example.test/minio:fixture",
      port: 9100,
      consolePort: 9101,
      command: [...CUSTOM_COMMAND],
    },
    authority: {
      ...launcherAuthority(MINIO_LISTENER, 9100),
      setting: "--address :9100 --console-address :9101",
    },
  },
  {
    id: "minio entrypoint-only preserves generated args and omits authority",
    serviceType: minioServiceType,
    feature: minioServiceFeature,
    service: {
      type: "minio",
      image: "example.test/minio:fixture",
      port: 9100,
      consolePort: 9101,
      entrypoint: [...CUSTOM_ENTRYPOINT],
    },
    authority: undefined,
    assertCalls: (calls) => {
      expect(calls).toContainEqual([
        "setCommand",
        ["server", "/data", "--address", ":9100", "--console-address", ":9101"],
      ]);
      expect(calls).toContainEqual(["setEntrypoint", [...CUSTOM_ENTRYPOINT]]);
    },
  },
  {
    id: "minio stock omits authority",
    serviceType: minioServiceType,
    feature: minioServiceFeature,
    service: {
      type: "minio",
      image: "example.test/minio:fixture",
      port: 9100,
      consolePort: 9101,
    },
    authority: undefined,
  },

  // --- static: command authority; entrypoint-only no authority ---
  {
    id: "static command authority",
    serviceType: staticNginxServiceType,
    feature: staticServiceFeature,
    service: { type: "static", port: 8080, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(STATIC_LISTENERS.nginx, 8080),
  },
  {
    id: "static caddy command authority",
    serviceType: staticCaddyServiceType,
    feature: staticServiceFeature,
    service: { type: "static:caddy", port: 8080, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(STATIC_LISTENERS.caddy, 8080),
  },
  {
    id: "static entrypoint-only omits authority",
    serviceType: staticNginxServiceType,
    feature: staticServiceFeature,
    service: { type: "static", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: undefined,
  },
  {
    id: "static stock omits authority",
    serviceType: staticNginxServiceType,
    feature: staticServiceFeature,
    service: { type: "static", port: 8080 },
    authority: undefined,
  },

  // --- nginx: command and entrypoint both authority ---
  {
    id: "nginx command authority",
    serviceType: nginxServiceType,
    feature: nginxServiceFeature,
    service: { type: "nginx", port: 8080, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(NGINX_LISTENER, 8080),
  },
  {
    id: "nginx entrypoint authority",
    serviceType: nginxServiceType,
    feature: nginxServiceFeature,
    service: { type: "nginx", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: launcherAuthority(NGINX_LISTENER, 8080),
  },
  {
    id: "nginx stock omits authority",
    serviceType: nginxServiceType,
    feature: nginxServiceFeature,
    service: { type: "nginx", port: 8080 },
    authority: undefined,
  },

  // --- apache: command and entrypoint both authority ---
  {
    id: "apache command authority",
    serviceType: apacheServiceType,
    feature: apacheServiceFeature,
    service: { type: "apache", port: 8080, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(APACHE_LISTENER, 8080),
  },
  {
    id: "apache entrypoint authority",
    serviceType: apacheServiceType,
    feature: apacheServiceFeature,
    service: { type: "apache", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: launcherAuthority(APACHE_LISTENER, 8080),
  },
  {
    id: "apache stock omits authority",
    serviceType: apacheServiceType,
    feature: apacheServiceFeature,
    service: { type: "apache", port: 8080 },
    authority: undefined,
  },

  // --- php: apache/fpm author-owned configuration authority; CLI omits ---
  {
    id: "php apache authored command authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", port: 8080, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(PHP_LISTENERS.apache, 8080),
  },
  {
    id: "php apache authored entrypoint authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: launcherAuthority(PHP_LISTENERS.apache, 8080),
  },
  {
    id: "php fpm authored command authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", port: 9001, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(PHP_LISTENERS.fpm, 9001),
  },
  {
    id: "php fpm authored entrypoint authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", port: 9001, entrypoint: [...CUSTOM_ENTRYPOINT] },
    authority: launcherAuthority(PHP_LISTENERS.fpm, 9001),
  },
  {
    id: "php cli authored command omits authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "cli", command: [...CUSTOM_COMMAND] },
    authority: undefined,
  },
  {
    id: "php apache image-default authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", image: "acme/php:custom", port: 8080 },
    authority: imageAuthority(PHP_LISTENERS.apache, 8080),
  },
  {
    id: "php fpm replacement build authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", build: { context: "." }, port: 9001 },
    authority: imageAuthority(PHP_LISTENERS.fpm, 9001),
  },
  {
    id: "php cli image-default omits authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "cli", image: "acme/php:custom" },
    authority: undefined,
  },
  {
    id: "php fpm image-default authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", image: "acme/php:custom", port: 9001 },
    authority: imageAuthority(PHP_LISTENERS.fpm, 9001),
  },
  {
    id: "php apache replacement build authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", build: { context: "." }, port: 8080 },
    authority: imageAuthority(PHP_LISTENERS.apache, 8080),
  },
  {
    id: "php stock apache omits authority",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", port: 8080 },
    authority: undefined,
  },

  // --- tomcat: stock (incl. authored command) no authority; custom image/build authority ---
  {
    id: "tomcat stock omits authority",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", port: 9090 },
    authority: undefined,
  },
  {
    id: "tomcat stock authored command omits authority",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", port: 9090, command: [...CUSTOM_COMMAND] },
    authority: undefined,
  },
  {
    id: "tomcat custom image authority",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", image: "acme/tomcat:custom", port: 9090 },
    authority: imageAuthority(TOMCAT_LISTENER, 9090),
  },
  {
    id: "tomcat build context authority",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", build: { context: "." }, port: 9090 },
    authority: imageAuthority(TOMCAT_LISTENER, 9090),
  },

  // --- varnish: authored cmd/entrypoint authority; stock none ---
  {
    id: "varnish command authority",
    serviceType: varnishServiceType,
    feature: varnishServiceFeature,
    service: { type: "varnish", backend: "appserver", port: 8080, command: [...CUSTOM_COMMAND] },
    authority: launcherAuthority(VARNISH_LISTENER, 8080),
  },
  {
    id: "varnish entrypoint authority",
    serviceType: varnishServiceType,
    feature: varnishServiceFeature,
    service: {
      type: "varnish",
      backend: "appserver",
      port: 8080,
      entrypoint: [...CUSTOM_ENTRYPOINT],
    },
    authority: launcherAuthority(VARNISH_LISTENER, 8080),
  },
  {
    id: "varnish stock omits authority",
    serviceType: varnishServiceType,
    feature: varnishServiceFeature,
    service: { type: "varnish", backend: "appserver", port: 8080 },
    authority: undefined,
  },
];

describe("launcher listener authority via feature.apply", () => {
  test.each(cases)("$id", ({ serviceType, feature, service, authority, assertCalls }) => {
    // Given a resolved service type (feature config + connection facts) and a recording context
    const resolution = resolveService(serviceType, service);

    // When the real service feature applies
    const { calls, authorities } = applyFeature(feature, resolution);

    // Then the recorded setListenerAuthority matches exact authorship conditions
    if (authority === undefined) {
      expect(authorities).toEqual([]);
    } else {
      expect(authorities).toEqual([authority]);
    }
    assertCalls?.(calls);
  });
});

describe("application listener authority", () => {
  for (const [type, framework, daemon, variables] of [
    ["node:22", undefined, "Node.js", ["PORT"]],
    ["python:3.12", undefined, "Python", ["PORT"]],
    ["python:3.12", "django", "Django", ["PORT"]],
    ["python:3.12", "fastapi", "FastAPI", ["PORT", "UVICORN_PORT"]],
    ["python:3.12", "flask", "Flask", ["PORT", "FLASK_RUN_PORT"]],
    ["ruby:3.3", undefined, "Ruby", ["PORT"]],
    ["ruby:3.3", "rails", "Rails", ["PORT"]],
    ["go:1.23", undefined, "Go", ["PORT"]],
    ["dotnet:8.0", undefined, "ASP.NET Core", ["ASPNETCORE_HTTP_PORTS"]],
  ] as const) {
    for (const [authorship, process] of [
      ["keep-alive", {}],
      ["command", { command: [...CUSTOM_COMMAND] }],
      ["entrypoint", { entrypoint: [...CUSTOM_ENTRYPOINT] }],
      ["both", { command: [...CUSTOM_COMMAND], entrypoint: [...CUSTOM_ENTRYPOINT] }],
    ] as const) {
      test(`${type}/${framework ?? "none"} retains application authority with ${authorship}`, async () => {
        const serviceType = serviceTypes.get(type);
        if (serviceType === undefined) throw new Error(`Missing service type ${type}`);
        const plan = await composeServicePlan({
          serviceType,
          service: { type, port: 43210, ...(framework === undefined ? {} : { framework }), ...process },
          serviceName: "web",
          appRoot: APP_ROOT,
          appName: "myapp",
          metadata: METADATA,
        });
        expect(plan.listenerAuthority).toEqual({ owner: "application", daemon, port: 43210, variables });
        if (process.command !== undefined) expect(plan.command).toEqual(process.command);
        if (process.entrypoint !== undefined) expect(plan.entrypoint).toEqual(process.entrypoint);
      });
    }
  }
});
