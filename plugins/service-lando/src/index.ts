import { type Effect, Layer, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { appFeatures } from "./app-features/index.ts";
import { SERVICE_FEATURE_IDS, serviceFeatures as bundledServiceFeatures } from "./features/index.ts";
import mailpitGlobalService from "./global-services/mailpit.ts";
import { apacheServiceType } from "./services/apache.ts";
import { composeServiceType } from "./services/compose.ts";
import { dotnet80ServiceType, dotnet90ServiceType, dotnetServiceType } from "./services/dotnet.ts";
import { elasticsearch8ServiceType, elasticsearchServiceType } from "./services/elasticsearch.ts";
import { go122ServiceType, go123ServiceType } from "./services/go.ts";
import { landoServiceType } from "./services/lando.ts";
import { localstackServiceType } from "./services/localstack.ts";
import { mailhogServiceType } from "./services/mailhog.ts";
import { mailpitServiceType } from "./services/mailpit.ts";
import { mariadbServiceType } from "./services/mariadb.ts";
import { meilisearch1ServiceType, meilisearchServiceType } from "./services/meilisearch.ts";
import { memcachedServiceType } from "./services/memcached.ts";
import { minioServiceType } from "./services/minio.ts";
import { mongodbServiceType } from "./services/mongodb.ts";
import { mssql2019ServiceType, mssql2022ServiceType, mssqlServiceType } from "./services/mssql.ts";
import { mysqlServiceType } from "./services/mysql.ts";
import { nginxServiceType } from "./services/nginx.ts";
import { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
import { opensearch2ServiceType, opensearchServiceType } from "./services/opensearch.ts";
import { php81ServiceType, php82ServiceType, php83ServiceType, php84ServiceType } from "./services/php.ts";
import {
  phpmyadmin5ServiceType,
  phpmyadminLatestServiceType,
  phpmyadminServiceType,
} from "./services/phpmyadmin.ts";
import { postgresServiceType } from "./services/postgres.ts";
import { python312ServiceType } from "./services/python.ts";
import { rabbitmq3ServiceType, rabbitmq4ServiceType, rabbitmqServiceType } from "./services/rabbitmq.ts";
import { redisServiceType } from "./services/redis.ts";
import { ruby33ServiceType } from "./services/ruby.ts";
import { solr9ServiceType, solrServiceType } from "./services/solr.ts";
import { staticCaddyServiceType, staticNginxServiceType } from "./services/static.ts";
import {
  tomcat9ServiceType,
  tomcat10ServiceType,
  tomcat11ServiceType,
  tomcatServiceType,
} from "./services/tomcat.ts";
import { valkeyServiceType } from "./services/valkey.ts";
import { varnish6ServiceType, varnish7ServiceType, varnishServiceType } from "./services/varnish.ts";

export const PLUGIN_NAME = "@lando/service-lando" as const;

export * from "./services/index.ts";

export const serviceTypes: ReadonlyMap<string, ServiceType> = new Map<string, ServiceType>([
  ["apache", apacheServiceType],
  ["compose", composeServiceType],
  ["dotnet", dotnetServiceType],
  ["dotnet:8.0", dotnet80ServiceType],
  ["dotnet:9.0", dotnet90ServiceType],
  ["elasticsearch", elasticsearchServiceType],
  ["elasticsearch:8", elasticsearch8ServiceType],
  ["go:1.22", go122ServiceType],
  ["go:1.23", go123ServiceType],
  ["lando", landoServiceType],
  ["localstack", localstackServiceType],
  ["mailhog", mailhogServiceType],
  ["mailpit", mailpitServiceType],
  ["mariadb", mariadbServiceType],
  ["meilisearch", meilisearchServiceType],
  ["meilisearch:1", meilisearch1ServiceType],
  ["memcached", memcachedServiceType],
  ["minio", minioServiceType],
  ["mongodb", mongodbServiceType],
  ["mssql", mssqlServiceType],
  ["mssql:2019", mssql2019ServiceType],
  ["mssql:2022", mssql2022ServiceType],
  ["mysql", mysqlServiceType],
  ["nginx", nginxServiceType],
  ["node:lts", nodeLtsServiceType],
  ["node:22", node22ServiceType],
  ["opensearch", opensearchServiceType],
  ["opensearch:2", opensearch2ServiceType],
  ["php:8.1", php81ServiceType],
  ["php:8.2", php82ServiceType],
  ["php:8.3", php83ServiceType],
  ["php:8.4", php84ServiceType],
  ["phpmyadmin", phpmyadminServiceType],
  ["phpmyadmin:5", phpmyadmin5ServiceType],
  ["phpmyadmin:latest", phpmyadminLatestServiceType],
  ["postgres", postgresServiceType],
  ["python:3.12", python312ServiceType],
  ["rabbitmq", rabbitmqServiceType],
  ["rabbitmq:3", rabbitmq3ServiceType],
  ["rabbitmq:4", rabbitmq4ServiceType],
  ["redis", redisServiceType],
  ["ruby:3.3", ruby33ServiceType],
  ["solr", solrServiceType],
  ["solr:9", solr9ServiceType],
  ["static", staticNginxServiceType],
  ["static:nginx", staticNginxServiceType],
  ["static:caddy", staticCaddyServiceType],
  ["tomcat", tomcatServiceType],
  ["tomcat:9", tomcat9ServiceType],
  ["tomcat:10", tomcat10ServiceType],
  ["tomcat:11", tomcat11ServiceType],
  ["valkey", valkeyServiceType],
  ["varnish", varnishServiceType],
  ["varnish:6", varnish6ServiceType],
  ["varnish:7", varnish7ServiceType],
]);

export const services = Layer.empty;

export const globalServices: ReadonlyMap<string, Effect.Effect<ServiceConfig>> = new Map([
  ["mailpit", mailpitGlobalService],
]);

export const serviceFeatures: ReadonlyMap<string, ServiceFeatureDefinition> = bundledServiceFeatures;

export { appFeatures };

export { SERVICE_FEATURE_IDS } from "./features/index.ts";

export {
  landoAppMountFeature,
  landoBootFeature,
  landoCertsFeature,
  landoEnvFeature,
  landoHealthcheckFeature,
  landoHostProxyFeature,
  landoSecurityFeature,
  landoStorageFeature,
  landoUserFeature,
  landoUserIdFeature,
} from "./features/index.ts";

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "The opinionated `lando` service base.",
  enabled: true,
  contributes: {
    globalServices: [
      {
        id: "mailpit",
        module: "./src/global-services/mailpit.ts",
        enabledByDefault: true,
        requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
        summary: "Global Mailpit SMTP capture server with web UI",
      },
    ],
    serviceTypes: [
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
    ],
    serviceFeatures: SERVICE_FEATURE_IDS,
    appFeatures: ["service-lando.phpmyadmin.wire"],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  layer: services,
  serviceTypes,
  serviceFeatures,
  appFeatures,
  globalServices,
});
