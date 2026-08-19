import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { apacheServiceFeature } from "../services/apache.ts";
import { composeServiceFeature } from "../services/compose.ts";
import { elasticsearchServiceFeature } from "../services/elasticsearch.ts";
import { goServiceFeature } from "../services/go.ts";
import { landoServiceFeature } from "../services/lando.ts";
import { localstackServiceFeature } from "../services/localstack.ts";
import { mailhogServiceFeature } from "../services/mailhog.ts";
import { mailpitServiceFeature } from "../services/mailpit.ts";
import { mariadbServiceFeature } from "../services/mariadb.ts";
import { meilisearchServiceFeature } from "../services/meilisearch.ts";
import { memcachedServiceFeature } from "../services/memcached.ts";
import { minioServiceFeature } from "../services/minio.ts";
import { mongodbServiceFeature } from "../services/mongodb.ts";
import { mysqlServiceFeature } from "../services/mysql.ts";
import { nginxServiceFeature } from "../services/nginx.ts";
import { nodeServiceFeature } from "../services/node.ts";
import { opensearchServiceFeature } from "../services/opensearch.ts";
import { phpServiceFeature } from "../services/php.ts";
import { postgresServiceFeature } from "../services/postgres.ts";
import { pythonServiceFeature } from "../services/python.ts";
import { rabbitmqServiceFeature } from "../services/rabbitmq.ts";
import { redisServiceFeature } from "../services/redis.ts";
import { rubyServiceFeature } from "../services/ruby.ts";
import { solrServiceFeature } from "../services/solr.ts";
import { staticServiceFeature } from "../services/static.ts";
import { valkeyServiceFeature } from "../services/valkey.ts";
import { landoAppMountFeature } from "./app-mount.ts";
import { landoBootFeature } from "./boot.ts";
import { landoCertsFeature } from "./certs.ts";
import { landoEnvFeature } from "./env.ts";
import { landoHealthcheckFeature } from "./healthcheck.ts";
import { landoHostProxyFeature } from "./host-proxy.ts";
import { landoSecurityFeature } from "./security.ts";
import { landoStorageFeature } from "./storage.ts";
import { landoUserIdFeature } from "./user-id.ts";
import { landoUserFeature } from "./user.ts";

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
};

const definitions: ReadonlyArray<ServiceFeatureDefinition> = [
  landoBootFeature,
  landoUserIdFeature,
  landoStorageFeature,
  landoEnvFeature,
  landoAppMountFeature,
  landoHealthcheckFeature,
  landoCertsFeature,
  landoSecurityFeature,
  landoHostProxyFeature,
  landoUserFeature,
  apacheServiceFeature,
  composeServiceFeature,
  elasticsearchServiceFeature,
  goServiceFeature,
  landoServiceFeature,
  localstackServiceFeature,
  mailhogServiceFeature,
  mailpitServiceFeature,
  mariadbServiceFeature,
  meilisearchServiceFeature,
  memcachedServiceFeature,
  minioServiceFeature,
  mongodbServiceFeature,
  mysqlServiceFeature,
  nginxServiceFeature,
  nodeServiceFeature,
  opensearchServiceFeature,
  phpServiceFeature,
  postgresServiceFeature,
  pythonServiceFeature,
  rabbitmqServiceFeature,
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
