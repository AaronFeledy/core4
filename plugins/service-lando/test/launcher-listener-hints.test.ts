import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType, ServiceTypeResolution } from "@lando/sdk/services";

import { authoredImageHint, authoredLauncherHint } from "../src/services/_port-helpers.ts";
import { apacheServiceFeature, apacheServiceType } from "../src/services/apache.ts";
import { memcachedServiceFeature, memcachedServiceType } from "../src/services/memcached.ts";
import { minioServiceFeature, minioServiceType } from "../src/services/minio.ts";
import { mongodbServiceFeature, mongodbServiceType } from "../src/services/mongodb.ts";
import { nginxServiceFeature, nginxServiceType } from "../src/services/nginx.ts";
import { php83ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { redisServiceFeature, redisServiceType } from "../src/services/redis.ts";
import { solrServiceFeature, solrServiceType } from "../src/services/solr.ts";
import {
  staticCaddyServiceType,
  staticNginxServiceType,
  staticServiceFeature,
} from "../src/services/static.ts";
import { tomcatServiceFeature, tomcatServiceType } from "../src/services/tomcat.ts";
import { valkeyServiceFeature, valkeyServiceType } from "../src/services/valkey.ts";
import { varnishServiceFeature, varnishServiceType } from "../src/services/varnish.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const APP_ROOT = "/srv/apps/myapp";
const METADATA = {
  resolvedAt: "2026-11-01T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const CUSTOM_ENTRYPOINT = ["custom-start"] as const;
const CUSTOM_COMMAND = ["custom-command"] as const;

type HintCase = {
  readonly id: string;
  readonly serviceType: ServiceType;
  readonly feature: ServiceFeatureDefinition;
  readonly service: ServiceConfig;
  /** Exact setting fragment passed to authoredLauncherHint, or undefined when no hint. */
  readonly setting: string | undefined;
  readonly daemon?: string;
  readonly imageOwned?: boolean;
  /** Extra assertions against recorded apply calls (beyond the hint). */
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
): { readonly calls: readonly (readonly unknown[])[]; readonly hints: readonly string[] } => {
  const featureRef = resolution.features.find((entry) => entry.id === feature.id);
  if (featureRef === undefined) throw new Error(`Missing resolved feature ${feature.id}`);
  const { ctx, calls } = recordFeatureContext({
    serviceType: resolution.normalizedConfig.type ?? feature.id,
    normalizedConfig: resolution.normalizedConfig,
    config: featureRef.config ?? {},
    connection: resolution.connection,
  });
  Effect.runSync(feature.apply(ctx));
  const hints = calls
    .filter((call): call is ["setStartupFailureHint", string] => call[0] === "setStartupFailureHint")
    .map((call) => call[1]);
  return { calls, hints };
};

const cases: readonly HintCase[] = [
  // --- mongodb: hint only when port or config AND authored process override ---
  {
    id: "mongodb port+command hints",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", port: 27018, command: [...CUSTOM_COMMAND] },
    daemon: "MongoDB",
    setting: "--port 27018",
  },
  {
    id: "mongodb port+entrypoint hints",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", port: 27018, entrypoint: [...CUSTOM_ENTRYPOINT] },
    daemon: "MongoDB",
    setting: "--port 27018",
  },
  {
    id: "mongodb config+command hints",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", config: { server: "config/mongod.conf" }, command: [...CUSTOM_COMMAND] },
    daemon: "MongoDB",
    setting: "--port 27017",
  },
  {
    id: "mongodb config+entrypoint hints",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: {
      type: "mongodb",
      config: { server: "config/mongod.conf" },
      entrypoint: [...CUSTOM_ENTRYPOINT],
    },
    daemon: "MongoDB",
    setting: "--port 27017",
  },
  {
    id: "mongodb command-only without port/config omits hint",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", command: [...CUSTOM_COMMAND] },
    setting: undefined,
  },
  {
    id: "mongodb entrypoint-only without port/config omits hint",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", entrypoint: [...CUSTOM_ENTRYPOINT] },
    setting: undefined,
  },
  {
    id: "mongodb stock port omits hint",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb", port: 27018 },
    setting: undefined,
  },
  {
    id: "mongodb default stock omits hint",
    serviceType: mongodbServiceType,
    feature: mongodbServiceFeature,
    service: { type: "mongodb" },
    setting: undefined,
  },

  // --- redis: command hints; entrypoint-only preserves Lando argv / no hint ---
  {
    id: "redis command hints",
    serviceType: redisServiceType,
    feature: redisServiceFeature,
    service: { type: "redis", port: 16379, command: [...CUSTOM_COMMAND] },
    daemon: "Redis",
    setting: "--port 16379",
  },
  {
    id: "redis entrypoint-only omits hint",
    serviceType: redisServiceType,
    feature: redisServiceFeature,
    service: { type: "redis", port: 16379, entrypoint: [...CUSTOM_ENTRYPOINT] },
    setting: undefined,
  },
  {
    id: "redis stock omits hint",
    serviceType: redisServiceType,
    feature: redisServiceFeature,
    service: { type: "redis", port: 16379 },
    setting: undefined,
  },

  // --- valkey ---
  {
    id: "valkey command hints",
    serviceType: valkeyServiceType,
    feature: valkeyServiceFeature,
    service: { type: "valkey", port: 6380, command: [...CUSTOM_COMMAND] },
    daemon: "Valkey",
    setting: "--port 6380",
  },
  {
    id: "valkey entrypoint-only omits hint",
    serviceType: valkeyServiceType,
    feature: valkeyServiceFeature,
    service: { type: "valkey", port: 6380, entrypoint: [...CUSTOM_ENTRYPOINT] },
    setting: undefined,
  },
  {
    id: "valkey stock omits hint",
    serviceType: valkeyServiceType,
    feature: valkeyServiceFeature,
    service: { type: "valkey", port: 6380 },
    setting: undefined,
  },

  // --- memcached ---
  {
    id: "memcached command hints",
    serviceType: memcachedServiceType,
    feature: memcachedServiceFeature,
    service: { type: "memcached", port: 11212, command: [...CUSTOM_COMMAND] },
    daemon: "Memcached",
    setting: "-p 11212",
  },
  {
    id: "memcached entrypoint-only omits hint",
    serviceType: memcachedServiceType,
    feature: memcachedServiceFeature,
    service: { type: "memcached", port: 11212, entrypoint: [...CUSTOM_ENTRYPOINT] },
    setting: undefined,
  },
  {
    id: "memcached stock omits hint",
    serviceType: memcachedServiceType,
    feature: memcachedServiceFeature,
    service: { type: "memcached", port: 11212 },
    setting: undefined,
  },

  // --- solr ---
  {
    id: "solr command hints",
    serviceType: solrServiceType,
    feature: solrServiceFeature,
    service: { type: "solr", port: 8984, command: [...CUSTOM_COMMAND] },
    daemon: "Solr",
    setting: "-p 8984",
  },
  {
    id: "solr entrypoint-only omits hint",
    serviceType: solrServiceType,
    feature: solrServiceFeature,
    service: { type: "solr", port: 8984, entrypoint: [...CUSTOM_ENTRYPOINT] },
    setting: undefined,
  },
  {
    id: "solr stock omits hint",
    serviceType: solrServiceType,
    feature: solrServiceFeature,
    service: { type: "solr", port: 8984 },
    setting: undefined,
  },

  // --- minio: command hints; entrypoint-only keeps generated args / no hint ---
  {
    id: "minio command hints",
    serviceType: minioServiceType,
    feature: minioServiceFeature,
    service: {
      type: "minio",
      image: "example.test/minio:fixture",
      port: 9100,
      consolePort: 9101,
      command: [...CUSTOM_COMMAND],
    },
    daemon: "MinIO",
    setting: "--address :9100 --console-address :9101",
  },
  {
    id: "minio entrypoint-only preserves generated args and omits hint",
    serviceType: minioServiceType,
    feature: minioServiceFeature,
    service: {
      type: "minio",
      image: "example.test/minio:fixture",
      port: 9100,
      consolePort: 9101,
      entrypoint: [...CUSTOM_ENTRYPOINT],
    },
    setting: undefined,
    assertCalls: (calls) => {
      expect(calls).toContainEqual([
        "setCommand",
        ["server", "/data", "--address", ":9100", "--console-address", ":9101"],
      ]);
      expect(calls).toContainEqual(["setEntrypoint", [...CUSTOM_ENTRYPOINT]]);
    },
  },
  {
    id: "minio stock omits hint",
    serviceType: minioServiceType,
    feature: minioServiceFeature,
    service: {
      type: "minio",
      image: "example.test/minio:fixture",
      port: 9100,
      consolePort: 9101,
    },
    setting: undefined,
  },

  // --- static: command hints; entrypoint-only no hint ---
  {
    id: "static command hints",
    serviceType: staticNginxServiceType,
    feature: staticServiceFeature,
    service: { type: "static", port: 8080, command: [...CUSTOM_COMMAND] },
    daemon: "nginx",
    setting: "listen 8080;",
  },
  {
    id: "static caddy command hints",
    serviceType: staticCaddyServiceType,
    feature: staticServiceFeature,
    service: { type: "static:caddy", port: 8080, command: [...CUSTOM_COMMAND] },
    daemon: "caddy",
    setting: "--listen :8080",
  },
  {
    id: "static entrypoint-only omits hint",
    serviceType: staticNginxServiceType,
    feature: staticServiceFeature,
    service: { type: "static", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    setting: undefined,
  },
  {
    id: "static stock omits hint",
    serviceType: staticNginxServiceType,
    feature: staticServiceFeature,
    service: { type: "static", port: 8080 },
    setting: undefined,
  },

  // --- nginx: command and entrypoint both hint ---
  {
    id: "nginx command hints",
    serviceType: nginxServiceType,
    feature: nginxServiceFeature,
    service: { type: "nginx", port: 8080, command: [...CUSTOM_COMMAND] },
    daemon: "nginx",
    setting: "listen 8080;",
  },
  {
    id: "nginx entrypoint hints",
    serviceType: nginxServiceType,
    feature: nginxServiceFeature,
    service: { type: "nginx", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    daemon: "nginx",
    setting: "listen 8080;",
  },
  {
    id: "nginx stock omits hint",
    serviceType: nginxServiceType,
    feature: nginxServiceFeature,
    service: { type: "nginx", port: 8080 },
    setting: undefined,
  },

  // --- apache: command and entrypoint both hint ---
  {
    id: "apache command hints",
    serviceType: apacheServiceType,
    feature: apacheServiceFeature,
    service: { type: "apache", port: 8080, command: [...CUSTOM_COMMAND] },
    daemon: "Apache",
    setting: "Listen 8080",
  },
  {
    id: "apache entrypoint hints",
    serviceType: apacheServiceType,
    feature: apacheServiceFeature,
    service: { type: "apache", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    daemon: "Apache",
    setting: "Listen 8080",
  },
  {
    id: "apache stock omits hint",
    serviceType: apacheServiceType,
    feature: apacheServiceFeature,
    service: { type: "apache", port: 8080 },
    setting: undefined,
  },

  // --- php: apache/fpm author-owned configuration hints; CLI omits ---
  {
    id: "php apache authored command hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", port: 8080, command: [...CUSTOM_COMMAND] },
    daemon: "Apache",
    setting: "Listen 8080",
  },
  {
    id: "php apache authored entrypoint hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", port: 8080, entrypoint: [...CUSTOM_ENTRYPOINT] },
    daemon: "Apache",
    setting: "Listen 8080",
  },
  {
    id: "php fpm authored command hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", port: 9001, command: [...CUSTOM_COMMAND] },
    daemon: "php-fpm",
    setting: "listen = 9001",
  },
  {
    id: "php fpm authored entrypoint hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", port: 9001, entrypoint: [...CUSTOM_ENTRYPOINT] },
    daemon: "php-fpm",
    setting: "listen = 9001",
  },
  {
    id: "php cli authored command omits hint",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "cli", command: [...CUSTOM_COMMAND] },
    setting: undefined,
  },
  {
    id: "php apache image-default hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", image: "acme/php:custom", port: 8080 },
    setting: "`Listen 8080`",
    daemon: "Apache",
    imageOwned: true,
  },
  {
    id: "php fpm replacement build hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", build: { context: "." }, port: 9001 },
    setting: "`listen = 9001`",
    daemon: "php-fpm",
    imageOwned: true,
  },
  {
    id: "php cli image-default omits hint",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "cli", image: "acme/php:custom" },
    setting: undefined,
  },
  {
    id: "php fpm image-default hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "fpm", image: "acme/php:custom", port: 9001 },
    setting: "`listen = 9001`",
    daemon: "php-fpm",
    imageOwned: true,
  },
  {
    id: "php apache replacement build hints",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", build: { context: "." }, port: 8080 },
    setting: "`Listen 8080`",
    daemon: "Apache",
    imageOwned: true,
  },
  {
    id: "php stock apache omits hint",
    serviceType: php83ServiceType,
    feature: phpServiceFeature,
    service: { type: "php:8.3", via: "apache", port: 8080 },
    setting: undefined,
  },

  // --- tomcat: stock (incl. authored command) no hint; custom image/build hint ---
  {
    id: "tomcat stock omits hint",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", port: 9090 },
    setting: undefined,
  },
  {
    id: "tomcat stock authored command omits hint",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", port: 9090, command: [...CUSTOM_COMMAND] },
    setting: undefined,
  },
  {
    id: "tomcat custom image hints",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", image: "acme/tomcat:custom", port: 9090 },
    daemon: "Tomcat",
    setting: '`<Connector port="9090">` in server.xml',
    imageOwned: true,
  },
  {
    id: "tomcat build context hints",
    serviceType: tomcatServiceType,
    feature: tomcatServiceFeature,
    service: { type: "tomcat", build: { context: "." }, port: 9090 },
    daemon: "Tomcat",
    setting: '`<Connector port="9090">` in server.xml',
    imageOwned: true,
  },

  // --- varnish: authored cmd/entrypoint hint; stock none ---
  {
    id: "varnish command hints",
    serviceType: varnishServiceType,
    feature: varnishServiceFeature,
    service: { type: "varnish", backend: "appserver", port: 8080, command: [...CUSTOM_COMMAND] },
    daemon: "Varnish",
    setting: "-a :8080",
  },
  {
    id: "varnish entrypoint hints",
    serviceType: varnishServiceType,
    feature: varnishServiceFeature,
    service: {
      type: "varnish",
      backend: "appserver",
      port: 8080,
      entrypoint: [...CUSTOM_ENTRYPOINT],
    },
    daemon: "Varnish",
    setting: "-a :8080",
  },
  {
    id: "varnish stock omits hint",
    serviceType: varnishServiceType,
    feature: varnishServiceFeature,
    service: { type: "varnish", backend: "appserver", port: 8080 },
    setting: undefined,
  },
];

describe("launcher listener startup failure hints via feature.apply", () => {
  test.each(cases)("$id", ({ serviceType, feature, service, setting, daemon, imageOwned, assertCalls }) => {
    // Given a resolved service type (feature config + connection facts) and a recording context
    const resolution = resolveService(serviceType, service);

    // When the real service feature applies
    const { calls, hints } = applyFeature(feature, resolution);

    // Then the recorded setStartupFailureHint matches exact authorship conditions
    if (setting === undefined) {
      expect(hints).toEqual([]);
    } else {
      const expectedDaemon = daemon ?? "daemon";
      expect(hints).toEqual([
        (imageOwned ? authoredImageHint : authoredLauncherHint)(expectedDaemon, setting),
      ]);
    }
    assertCalls?.(calls);
  });
});
