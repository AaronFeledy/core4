import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { apacheServiceType } from "./services/apache.ts";
import { composeServiceType } from "./services/compose.ts";
import { go122ServiceType, go123ServiceType } from "./services/go.ts";
import { mariadbServiceType } from "./services/mariadb.ts";
import { memcachedServiceType } from "./services/memcached.ts";
import { mongodbServiceType } from "./services/mongodb.ts";
import { mysqlServiceType } from "./services/mysql.ts";
import { nginxServiceType } from "./services/nginx.ts";
import { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
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
export { go122ServiceType, go123ServiceType } from "./services/go.ts";
export { mariadbServiceType } from "./services/mariadb.ts";
export { memcachedServiceType } from "./services/memcached.ts";
export { mongodbServiceType } from "./services/mongodb.ts";
export { mysqlServiceType } from "./services/mysql.ts";
export { nginxServiceType } from "./services/nginx.ts";
export { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
export { php82ServiceType, php83ServiceType } from "./services/php.ts";
export { postgresServiceType } from "./services/postgres.ts";
export { python312ServiceType } from "./services/python.ts";
export { redisServiceType } from "./services/redis.ts";
export { ruby33ServiceType } from "./services/ruby.ts";
export { solr9ServiceType, solrServiceType } from "./services/solr.ts";
export { staticCaddyServiceType, staticNginxServiceType } from "./services/static.ts";
export { valkeyServiceType } from "./services/valkey.ts";

export const serviceTypes: ReadonlyMap<string, ServiceTypeShape> = new Map<string, ServiceTypeShape>([
  ["apache", apacheServiceType],
  ["compose", composeServiceType],
  ["go:1.22", go122ServiceType],
  ["go:1.23", go123ServiceType],
  ["mariadb", mariadbServiceType],
  ["memcached", memcachedServiceType],
  ["mongodb", mongodbServiceType],
  ["mysql", mysqlServiceType],
  ["nginx", nginxServiceType],
  ["node:lts", nodeLtsServiceType],
  ["node:22", node22ServiceType],
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

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "The opinionated `lando` service base.",
  enabled: true,
  contributes: {
    serviceTypes: [
      "apache",
      "compose",
      "go:1.22",
      "go:1.23",
      "mariadb",
      "memcached",
      "mongodb",
      "mysql",
      "nginx",
      "node:lts",
      "node:22",
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
  },
  entry: "./src/index.ts",
});
