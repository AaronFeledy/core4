import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { apacheServiceFeature } from "../services/apache.ts";
import { composeServiceFeature } from "../services/compose.ts";
import { elasticsearchServiceFeature } from "../services/elasticsearch.ts";
import { goServiceFeature } from "../services/go.ts";
import { mariadbServiceFeature } from "../services/mariadb.ts";
import { meilisearchServiceFeature } from "../services/meilisearch.ts";
import { memcachedServiceFeature } from "../services/memcached.ts";
import { mongodbServiceFeature } from "../services/mongodb.ts";
import { mysqlServiceFeature } from "../services/mysql.ts";
import { nginxServiceFeature } from "../services/nginx.ts";
import { nodeServiceFeature } from "../services/node.ts";
import { opensearchServiceFeature } from "../services/opensearch.ts";
import { phpServiceFeature } from "../services/php.ts";
import { postgresServiceFeature } from "../services/postgres.ts";
import { pythonServiceFeature } from "../services/python.ts";
import { redisServiceFeature } from "../services/redis.ts";
import { rubyServiceFeature } from "../services/ruby.ts";
import { solrServiceFeature } from "../services/solr.ts";
import { staticServiceFeature } from "../services/static.ts";
import { valkeyServiceFeature } from "../services/valkey.ts";
import { landoAppMountFeature } from "./app-mount.ts";
import { landoEnvFeature } from "./env.ts";
import { landoHealthcheckFeature } from "./healthcheck.ts";
import { landoStorageFeature } from "./storage.ts";
import { landoUserIdFeature } from "./user-id.ts";
import { landoUserFeature } from "./user.ts";

export { landoAppMountFeature } from "./app-mount.ts";
export { landoEnvFeature } from "./env.ts";
export { landoHealthcheckFeature } from "./healthcheck.ts";
export { landoStorageFeature } from "./storage.ts";
export { landoUserFeature } from "./user.ts";
export { landoUserIdFeature } from "./user-id.ts";

const definitions: ReadonlyArray<ServiceFeatureDefinition> = [
  landoUserIdFeature,
  landoStorageFeature,
  landoEnvFeature,
  landoAppMountFeature,
  landoHealthcheckFeature,
  landoUserFeature,
  apacheServiceFeature,
  composeServiceFeature,
  elasticsearchServiceFeature,
  goServiceFeature,
  mariadbServiceFeature,
  meilisearchServiceFeature,
  memcachedServiceFeature,
  mongodbServiceFeature,
  mysqlServiceFeature,
  nginxServiceFeature,
  nodeServiceFeature,
  opensearchServiceFeature,
  phpServiceFeature,
  postgresServiceFeature,
  pythonServiceFeature,
  redisServiceFeature,
  rubyServiceFeature,
  solrServiceFeature,
  staticServiceFeature,
  valkeyServiceFeature,
];

export const serviceFeatures: ReadonlyMap<string, ServiceFeatureDefinition> = new Map(
  definitions.map((definition) => [definition.id, definition]),
);

export const SERVICE_FEATURE_IDS: ReadonlyArray<string> = definitions.map((definition) => definition.id);
