import { type Effect, Layer, Schema } from "effect";

import { PluginManifest, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { SERVICE_FEATURE_IDS, serviceFeatures as bundledServiceFeatures } from "./features/index.ts";
import mailpitGlobalService from "./global-services/mailpit.ts";
import { apacheServiceType } from "./services/apache.ts";
import { composeServiceType } from "./services/compose.ts";
import { elasticsearch8ServiceType, elasticsearchServiceType } from "./services/elasticsearch.ts";
import { go122ServiceType, go123ServiceType } from "./services/go.ts";
import { landoServiceType } from "./services/lando.ts";
import { mariadbServiceType } from "./services/mariadb.ts";
import { meilisearch1ServiceType, meilisearchServiceType } from "./services/meilisearch.ts";
import { memcachedServiceType } from "./services/memcached.ts";
import { mongodbServiceType } from "./services/mongodb.ts";
import { mysqlServiceType } from "./services/mysql.ts";
import { nginxServiceType } from "./services/nginx.ts";
import { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
import { opensearch2ServiceType, opensearchServiceType } from "./services/opensearch.ts";
import { php82ServiceType, php83ServiceType } from "./services/php.ts";
import { postgresServiceType } from "./services/postgres.ts";
import { python312ServiceType } from "./services/python.ts";
import { redisServiceType } from "./services/redis.ts";
import { ruby33ServiceType } from "./services/ruby.ts";
import { solr9ServiceType, solrServiceType } from "./services/solr.ts";
import { staticCaddyServiceType, staticNginxServiceType } from "./services/static.ts";
import { valkeyServiceType } from "./services/valkey.ts";

export const PLUGIN_NAME = "@lando/service-lando" as const;

export { apacheServiceType } from "./services/apache.ts";
export { composeServiceType } from "./services/compose.ts";
export { elasticsearch8ServiceType, elasticsearchServiceType } from "./services/elasticsearch.ts";
export { go122ServiceType, go123ServiceType } from "./services/go.ts";
export { landoServiceType } from "./services/lando.ts";
export { mariadbServiceType } from "./services/mariadb.ts";
export {
  MEILISEARCH_DEFAULT_MASTER_KEY,
  MEILISEARCH_SERVICE_DESCRIPTION,
  meilisearch1ServiceType,
  meilisearchServiceType,
} from "./services/meilisearch.ts";
export { memcachedServiceType } from "./services/memcached.ts";
export { mongodbServiceType } from "./services/mongodb.ts";
export { mysqlServiceType } from "./services/mysql.ts";
export { nginxServiceType } from "./services/nginx.ts";
export { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
export {
  OPENSEARCH_SERVICE_DESCRIPTION,
  opensearch2ServiceType,
  opensearchServiceType,
} from "./services/opensearch.ts";
export { php82ServiceType, php83ServiceType } from "./services/php.ts";
export { postgresServiceType } from "./services/postgres.ts";
export { python312ServiceType } from "./services/python.ts";
export { redisServiceType } from "./services/redis.ts";
export { ruby33ServiceType } from "./services/ruby.ts";
export { solr9ServiceType, solrServiceType } from "./services/solr.ts";
export { staticCaddyServiceType, staticNginxServiceType } from "./services/static.ts";
export { valkeyServiceType } from "./services/valkey.ts";

export const serviceTypes: ReadonlyMap<string, ServiceType> = new Map<string, ServiceType>([
  ["apache", apacheServiceType],
  ["compose", composeServiceType],
  ["elasticsearch", elasticsearchServiceType],
  ["elasticsearch:8", elasticsearch8ServiceType],
  ["go:1.22", go122ServiceType],
  ["go:1.23", go123ServiceType],
  ["lando", landoServiceType],
  ["mariadb", mariadbServiceType],
  ["meilisearch", meilisearchServiceType],
  ["meilisearch:1", meilisearch1ServiceType],
  ["memcached", memcachedServiceType],
  ["mongodb", mongodbServiceType],
  ["mysql", mysqlServiceType],
  ["nginx", nginxServiceType],
  ["node:lts", nodeLtsServiceType],
  ["node:22", node22ServiceType],
  ["opensearch", opensearchServiceType],
  ["opensearch:2", opensearch2ServiceType],
  ["postgres", postgresServiceType],
  ["php:8.2", php82ServiceType],
  ["php:8.3", php83ServiceType],
  ["python:3.12", python312ServiceType],
  ["redis", redisServiceType],
  ["ruby:3.3", ruby33ServiceType],
  ["solr", solrServiceType],
  ["solr:9", solr9ServiceType],
  ["static", staticNginxServiceType],
  ["static:nginx", staticNginxServiceType],
  ["static:caddy", staticCaddyServiceType],
  ["valkey", valkeyServiceType],
]);

export const services = Layer.empty;

/** Static global-service contributions, keyed by contribution id. */
export const globalServices: ReadonlyMap<string, Effect.Effect<ServiceConfig>> = new Map([
  ["mailpit", mailpitGlobalService],
]);

export const serviceFeatures: ReadonlyMap<string, ServiceFeatureDefinition> = bundledServiceFeatures;

export { SERVICE_FEATURE_IDS } from "./features/index.ts";

export {
  landoAppMountFeature,
  landoEnvFeature,
  landoHealthcheckFeature,
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
      "php:8.2",
      "php:8.3",
      "python:3.12",
      "redis",
      "ruby:3.3",
      "solr",
      "solr:9",
      "static",
      "static:nginx",
      "static:caddy",
      "valkey",
    ],
    serviceFeatures: SERVICE_FEATURE_IDS,
  },
  entry: "./src/index.ts",
});
