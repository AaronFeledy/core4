import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { runServiceCompositionContract } from "@lando/sdk/test";

import { apacheServiceType } from "../src/services/apache.ts";
import { composeServiceType } from "../src/services/compose.ts";
import { dotnet80ServiceType, dotnet90ServiceType, dotnetServiceType } from "../src/services/dotnet.ts";
import { elasticsearch8ServiceType, elasticsearchServiceType } from "../src/services/elasticsearch.ts";
import { go122ServiceType, go123ServiceType } from "../src/services/go.ts";
import { landoServiceType } from "../src/services/lando.ts";
import { localstackServiceType } from "../src/services/localstack.ts";
import { mailhogServiceType } from "../src/services/mailhog.ts";
import { mailpitServiceType } from "../src/services/mailpit.ts";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { meilisearch1ServiceType, meilisearchServiceType } from "../src/services/meilisearch.ts";
import { memcachedServiceType } from "../src/services/memcached.ts";
import { minioServiceType } from "../src/services/minio.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { mssql2019ServiceType, mssql2022ServiceType, mssqlServiceType } from "../src/services/mssql.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { nginxServiceType } from "../src/services/nginx.ts";
import { node22ServiceType, nodeLtsServiceType } from "../src/services/node.ts";
import { opensearch2ServiceType, opensearchServiceType } from "../src/services/opensearch.ts";
import { php82ServiceType, php83ServiceType, php85ServiceType } from "../src/services/php.ts";
import {
  phpmyadmin5ServiceType,
  phpmyadminLatestServiceType,
  phpmyadminServiceType,
} from "../src/services/phpmyadmin.ts";
import { postgresServiceType } from "../src/services/postgres.ts";
import { python312ServiceType } from "../src/services/python.ts";
import { rabbitmq3ServiceType, rabbitmq4ServiceType, rabbitmqServiceType } from "../src/services/rabbitmq.ts";
import { redisServiceType } from "../src/services/redis.ts";
import { ruby33ServiceType } from "../src/services/ruby.ts";
import { solr9ServiceType, solrServiceType } from "../src/services/solr.ts";
import { staticCaddyServiceType, staticNginxServiceType } from "../src/services/static.ts";
import {
  tomcat9ServiceType,
  tomcat10ServiceType,
  tomcat11ServiceType,
  tomcatServiceType,
} from "../src/services/tomcat.ts";
import { valkeyServiceType } from "../src/services/valkey.ts";
import { varnish6ServiceType, varnish7ServiceType, varnishServiceType } from "../src/services/varnish.ts";

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
  { serviceType: dotnetServiceType, landofileService: { type: "dotnet" } },
  { serviceType: dotnet80ServiceType, landofileService: { type: "dotnet:8.0" } },
  { serviceType: dotnet90ServiceType, landofileService: { type: "dotnet:9.0" } },
  { serviceType: elasticsearchServiceType, landofileService: { type: "elasticsearch" } },
  { serviceType: elasticsearch8ServiceType, landofileService: { type: "elasticsearch:8" } },
  { serviceType: go122ServiceType, landofileService: { type: "go:1.22" } },
  { serviceType: go123ServiceType, landofileService: { type: "go:1.23" } },
  {
    serviceType: landoServiceType,
    landofileService: { type: "lando", image: "debian:12.11-slim" },
    serviceName: "toolbox",
  },
  { serviceType: localstackServiceType, landofileService: { type: "localstack" } },
  { serviceType: mailhogServiceType, landofileService: { type: "mailhog" } },
  { serviceType: mailpitServiceType, landofileService: { type: "mailpit" } },
  { serviceType: mariadbServiceType, landofileService: { type: "mariadb" } },
  { serviceType: meilisearchServiceType, landofileService: { type: "meilisearch" } },
  { serviceType: meilisearch1ServiceType, landofileService: { type: "meilisearch:1" } },
  { serviceType: memcachedServiceType, landofileService: { type: "memcached" } },
  { serviceType: minioServiceType, landofileService: { type: "minio", database: "uploads" } },
  { serviceType: mongodbServiceType, landofileService: { type: "mongodb" } },
  { serviceType: mssqlServiceType, landofileService: { type: "mssql" } },
  { serviceType: mssql2019ServiceType, landofileService: { type: "mssql:2019" } },
  { serviceType: mssql2022ServiceType, landofileService: { type: "mssql:2022" } },
  { serviceType: mysqlServiceType, landofileService: { type: "mysql" } },
  { serviceType: nginxServiceType, landofileService: { type: "nginx" } },
  { serviceType: nodeLtsServiceType, landofileService: { type: "node:lts" } },
  { serviceType: node22ServiceType, landofileService: { type: "node:22" } },
  { serviceType: opensearchServiceType, landofileService: { type: "opensearch" } },
  { serviceType: opensearch2ServiceType, landofileService: { type: "opensearch:2" } },
  { serviceType: phpmyadminServiceType, landofileService: { type: "phpmyadmin" } },
  { serviceType: phpmyadmin5ServiceType, landofileService: { type: "phpmyadmin:5" } },
  { serviceType: phpmyadminLatestServiceType, landofileService: { type: "phpmyadmin:latest" } },
  { serviceType: php82ServiceType, landofileService: { type: "php:8.2" } },
  { serviceType: php83ServiceType, landofileService: { type: "php:8.3" } },
  { serviceType: php85ServiceType, landofileService: { type: "php:8.5" } },
  { serviceType: postgresServiceType, landofileService: { type: "postgres" } },
  { serviceType: python312ServiceType, landofileService: { type: "python:3.12" } },
  { serviceType: rabbitmqServiceType, landofileService: { type: "rabbitmq" } },
  { serviceType: rabbitmq3ServiceType, landofileService: { type: "rabbitmq:3" } },
  { serviceType: rabbitmq4ServiceType, landofileService: { type: "rabbitmq:4" } },
  { serviceType: redisServiceType, landofileService: { type: "redis" } },
  { serviceType: ruby33ServiceType, landofileService: { type: "ruby:3.3" } },
  { serviceType: solrServiceType, landofileService: { type: "solr" } },
  { serviceType: solr9ServiceType, landofileService: { type: "solr:9" } },
  { serviceType: staticNginxServiceType, landofileService: { type: "static:nginx" } },
  { serviceType: staticCaddyServiceType, landofileService: { type: "static:caddy" } },
  { serviceType: tomcatServiceType, landofileService: { type: "tomcat" } },
  { serviceType: tomcat9ServiceType, landofileService: { type: "tomcat:9" } },
  { serviceType: tomcat10ServiceType, landofileService: { type: "tomcat:10" } },
  { serviceType: tomcat11ServiceType, landofileService: { type: "tomcat:11" } },
  { serviceType: valkeyServiceType, landofileService: { type: "valkey" } },
  { serviceType: varnishServiceType, landofileService: { type: "varnish", backend: "web" } },
  { serviceType: varnish6ServiceType, landofileService: { type: "varnish:6", backend: "web" } },
  { serviceType: varnish7ServiceType, landofileService: { type: "varnish:7", backend: "web" } },
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

describe("service catalog per-type checklist × composition contract suite", () => {
  for (const entry of catalogEntries) {
    test(`${entry.serviceType.id} satisfies runServiceCompositionContract`, async () => {
      return expect(
        Effect.runPromise(
          runServiceCompositionContract({
            serviceType: entry.serviceType,
            landofileService: entry.landofileService,
            appName: "myapp",
            appRoot: "/srv/apps/myapp",
            providerId: ProviderId.make("lando"),
            ...(entry.serviceName === undefined ? {} : { serviceName: entry.serviceName }),
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
          host: {
            os: "linux",
            user: "test",
            uid: "1000",
            gid: "1000",
            home: "/home/test",
            arch: "x64",
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
      "node:22",
      "node:lts",
      "opensearch",
      "opensearch:2",
      "php:8.2",
      "php:8.3",
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
      "static:caddy",
      "tomcat",
      "tomcat:10",
      "tomcat:11",
      "tomcat:9",
      "valkey",
      "varnish",
      "varnish:6",
      "varnish:7",
    ]);
  });
});
