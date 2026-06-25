import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { runServiceCompositionContract } from "@lando/sdk/test";

import { apacheServiceType } from "../src/services/apache.ts";
import { composeServiceType } from "../src/services/compose.ts";
import { elasticsearch8ServiceType, elasticsearchServiceType } from "../src/services/elasticsearch.ts";
import { go122ServiceType, go123ServiceType } from "../src/services/go.ts";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { meilisearch1ServiceType, meilisearchServiceType } from "../src/services/meilisearch.ts";
import { memcachedServiceType } from "../src/services/memcached.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { nginxServiceType } from "../src/services/nginx.ts";
import { node22ServiceType, nodeLtsServiceType } from "../src/services/node.ts";
import { opensearch2ServiceType, opensearchServiceType } from "../src/services/opensearch.ts";
import { php82ServiceType, php83ServiceType } from "../src/services/php.ts";
import { postgresServiceType } from "../src/services/postgres.ts";
import { python312ServiceType } from "../src/services/python.ts";
import { redisServiceType } from "../src/services/redis.ts";
import { ruby33ServiceType } from "../src/services/ruby.ts";
import { solr9ServiceType, solrServiceType } from "../src/services/solr.ts";
import { staticCaddyServiceType, staticNginxServiceType } from "../src/services/static.ts";
import { valkeyServiceType } from "../src/services/valkey.ts";

interface CatalogCompositionEntry {
  readonly serviceType: ServiceType;
  readonly landofileService: Record<string, unknown>;
  readonly serviceName?: string;
}

const catalogEntries: ReadonlyArray<CatalogCompositionEntry> = [
  { serviceType: apacheServiceType, landofileService: { type: "apache" } },
  {
    serviceType: composeServiceType,
    landofileService: { type: "compose", image: "busybox:1.36" },
    serviceName: "worker",
  },
  { serviceType: elasticsearchServiceType, landofileService: { type: "elasticsearch" } },
  { serviceType: elasticsearch8ServiceType, landofileService: { type: "elasticsearch:8" } },
  { serviceType: go122ServiceType, landofileService: { type: "go:1.22" } },
  { serviceType: go123ServiceType, landofileService: { type: "go:1.23" } },
  { serviceType: mariadbServiceType, landofileService: { type: "mariadb" } },
  { serviceType: meilisearchServiceType, landofileService: { type: "meilisearch" } },
  { serviceType: meilisearch1ServiceType, landofileService: { type: "meilisearch:1" } },
  { serviceType: memcachedServiceType, landofileService: { type: "memcached" } },
  { serviceType: mongodbServiceType, landofileService: { type: "mongodb" } },
  { serviceType: mysqlServiceType, landofileService: { type: "mysql" } },
  { serviceType: nginxServiceType, landofileService: { type: "nginx" } },
  { serviceType: nodeLtsServiceType, landofileService: { type: "node:lts" } },
  { serviceType: node22ServiceType, landofileService: { type: "node:22" } },
  { serviceType: opensearchServiceType, landofileService: { type: "opensearch" } },
  { serviceType: opensearch2ServiceType, landofileService: { type: "opensearch:2" } },
  { serviceType: php82ServiceType, landofileService: { type: "php:8.2" } },
  { serviceType: php83ServiceType, landofileService: { type: "php:8.3" } },
  { serviceType: postgresServiceType, landofileService: { type: "postgres" } },
  { serviceType: python312ServiceType, landofileService: { type: "python:3.12" } },
  { serviceType: redisServiceType, landofileService: { type: "redis" } },
  { serviceType: ruby33ServiceType, landofileService: { type: "ruby:3.3" } },
  { serviceType: solrServiceType, landofileService: { type: "solr" } },
  { serviceType: solr9ServiceType, landofileService: { type: "solr:9" } },
  { serviceType: staticNginxServiceType, landofileService: { type: "static:nginx" } },
  { serviceType: staticCaddyServiceType, landofileService: { type: "static:caddy" } },
  { serviceType: valkeyServiceType, landofileService: { type: "valkey" } },
];

const decodeService = (entry: CatalogCompositionEntry) => {
  const serviceName = entry.serviceName ?? "web";
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { [serviceName]: entry.landofileService },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${entry.serviceType.id} service missing from fixture`);
  return { service, serviceName };
};

describe("service catalog × composition contract suite", () => {
  for (const entry of catalogEntries) {
    test(`${entry.serviceType.id} satisfies runServiceCompositionContract`, async () => {
      await expect(
        Effect.runPromise(
          runServiceCompositionContract({
            serviceType: entry.serviceType,
            landofileService: entry.landofileService,
            serviceName: entry.serviceName,
            appName: "myapp",
            appRoot: "/srv/apps/myapp",
            providerId: ProviderId.make("lando"),
          }),
        ),
      ).resolves.toBeUndefined();
    });

    test(`${entry.serviceType.id} resolves to a non-empty feature composition with matching base`, async () => {
      const { service, serviceName } = decodeService(entry);
      const resolution = await Effect.runPromise(
        entry.serviceType.resolve({
          name: serviceName,
          service,
          appName: "myapp",
          appRoot: "/srv/apps/myapp",
          provider: ProviderId.make("lando"),
          primary: serviceName === "web",
          metadata: {
            resolvedAt: "2026-05-18T08:00:00Z",
            source: "@lando/service-lando/test/service-contract",
            runtime: 4,
          },
        }),
      );

      expect(resolution.base).toBe(entry.serviceType.base);
      expect(resolution.features.length).toBeGreaterThan(0);
      expect(resolution.features.every((feature) => feature.id.length > 0)).toBe(true);
    });
  }

  test("catalog contract covers every exported service type variant", () => {
    expect(catalogEntries.map((entry) => entry.serviceType.id).sort()).toEqual([
      "apache",
      "compose",
      "elasticsearch",
      "elasticsearch:8",
      "go:1.22",
      "go:1.23",
      "mariadb",
      "meilisearch",
      "meilisearch:1",
      "memcached",
      "mongodb",
      "mysql",
      "nginx",
      "node:22",
      "node:lts",
      "opensearch",
      "opensearch:2",
      "php:8.2",
      "php:8.3",
      "postgres",
      "python:3.12",
      "redis",
      "ruby:3.3",
      "solr",
      "solr:9",
      "static",
      "static:caddy",
      "valkey",
    ]);
  });
});
