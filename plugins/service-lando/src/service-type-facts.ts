import type { ServiceType } from "@lando/sdk/services";
import { MAILPIT_WEB_PORT } from "./mailpit-constants.ts";
import { APP_MOUNT_TARGET as LANGUAGE_APP_MOUNT } from "./services/_language-runtime.ts";
import type { ListenerContract } from "./services/_port-helpers.ts";
import { APP_MOUNT_TARGET as APACHE_APP_MOUNT, APACHE_LISTENER } from "./services/apache.ts";
import { APP_MOUNT_TARGET as COMPOSE_APP_MOUNT } from "./services/compose.ts";
import { APP_MOUNT_TARGET as DOTNET_APP_MOUNT, DOTNET_LISTENER } from "./services/dotnet.ts";
import { ELASTICSEARCH_LISTENER } from "./services/elasticsearch.ts";
import { GO_LISTENER } from "./services/go.ts";
import { APP_MOUNT_TARGET as LANDO_APP_MOUNT } from "./services/lando.ts";
import { LOCALSTACK_LISTENER } from "./services/localstack.ts";
import { MAILHOG_LISTENER } from "./services/mailhog.ts";
import { MAILPIT_LISTENER } from "./services/mailpit.ts";
import { MARIADB_CONFIG_TARGET, MARIADB_LISTENER } from "./services/mariadb.ts";
import { MEILISEARCH_LISTENER } from "./services/meilisearch.ts";
import { MEMCACHED_LISTENER } from "./services/memcached.ts";
import { MINIO_LISTENER } from "./services/minio.ts";
import { MONGODB_CONFIG_TARGET, MONGODB_LISTENER } from "./services/mongodb.ts";
import { MSSQL_LISTENER } from "./services/mssql.ts";
import { MYSQL_CONFIG_TARGET, MYSQL_LISTENER } from "./services/mysql.ts";
import { APP_MOUNT_TARGET as NGINX_APP_MOUNT, NGINX_LISTENER } from "./services/nginx.ts";
import { APP_MOUNT_TARGET as NODE_APP_MOUNT, NODE_LISTENER } from "./services/node.ts";
import { OPENSEARCH_LISTENER } from "./services/opensearch.ts";
import { PHP_LISTENERS } from "./services/php-via.ts";
import { APP_MOUNT_TARGET as PHP_APP_MOUNT, PHP_LISTENER } from "./services/php.ts";
import { PHPMYADMIN_LISTENER } from "./services/phpmyadmin.ts";
import { POSTGRES_CONFIG_TARGET, POSTGRES_LISTENER } from "./services/postgres.ts";
import { PYTHON_LISTENERS } from "./services/python.ts";
import { MANAGEMENT_PORT, RABBITMQ_LISTENER } from "./services/rabbitmq.ts";
import { REDIS_LISTENER } from "./services/redis.ts";
import { RUBY_LISTENERS } from "./services/ruby.ts";
import { SOLR_CONFIG_TARGET, SOLR_LISTENER } from "./services/solr.ts";
import {
  APP_MOUNT_TARGET as STATIC_APP_MOUNT,
  STATIC_LISTENER,
  STATIC_LISTENERS,
} from "./services/static.ts";
import { APP_MOUNT_TARGET as TOMCAT_APP_MOUNT, TOMCAT_LISTENER } from "./services/tomcat.ts";
import { VALKEY_LISTENER } from "./services/valkey.ts";
import { VARNISH_LISTENER } from "./services/varnish.ts";

/**
 * Frozen registry of listener contracts. Family keys are the default variant;
 * `family/variant` keys cover non-default variants (python/ruby frameworks,
 * php/fpm, static/caddy).
 */
export const listenerContracts = (): Readonly<Record<string, ListenerContract>> => ({
  apache: APACHE_LISTENER,
  dotnet: DOTNET_LISTENER,
  elasticsearch: ELASTICSEARCH_LISTENER,
  go: GO_LISTENER,
  localstack: LOCALSTACK_LISTENER,
  mailhog: MAILHOG_LISTENER,
  mailpit: MAILPIT_LISTENER,
  mariadb: MARIADB_LISTENER,
  meilisearch: MEILISEARCH_LISTENER,
  memcached: MEMCACHED_LISTENER,
  minio: MINIO_LISTENER,
  mongodb: MONGODB_LISTENER,
  mssql: MSSQL_LISTENER,
  mysql: MYSQL_LISTENER,
  nginx: NGINX_LISTENER,
  node: NODE_LISTENER,
  opensearch: OPENSEARCH_LISTENER,
  php: PHP_LISTENER,
  "php/fpm": PHP_LISTENERS.fpm,
  phpmyadmin: PHPMYADMIN_LISTENER,
  postgres: POSTGRES_LISTENER,
  python: PYTHON_LISTENERS.none,
  "python/django": PYTHON_LISTENERS.django,
  "python/fastapi": PYTHON_LISTENERS.fastapi,
  "python/flask": PYTHON_LISTENERS.flask,
  rabbitmq: RABBITMQ_LISTENER,
  redis: REDIS_LISTENER,
  ruby: RUBY_LISTENERS.none,
  "ruby/rails": RUBY_LISTENERS.rails,
  solr: SOLR_LISTENER,
  static: STATIC_LISTENER,
  "static/caddy": STATIC_LISTENERS.caddy,
  tomcat: TOMCAT_LISTENER,
  valkey: VALKEY_LISTENER,
  varnish: VARNISH_LISTENER,
});

export type ServiceTypeFacts = {
  readonly versions: readonly string[];
  readonly listener?: { readonly port: number; readonly variable?: string };
  readonly httpPort?: number;
  readonly appMountTarget?: string;
  readonly configTargets?: { readonly server?: string; readonly dir?: string };
};

/** Default facts only: PHP's listener changes with via, and framework presets may change ports. */
export const buildServiceTypeFacts = (
  types: ReadonlyMap<string, ServiceType>,
): Readonly<Record<string, ServiceTypeFacts>> => {
  const http = (listener: Pick<ListenerContract, "port" | "variables">) => ({
    listener,
    httpPort: listener.port,
  });
  const defaults: Readonly<
    Record<
      string,
      Omit<ServiceTypeFacts, "versions" | "listener"> & {
        readonly listener?: Pick<ListenerContract, "port" | "variables">;
      }
    >
  > = {
    apache: { ...http(APACHE_LISTENER), appMountTarget: APACHE_APP_MOUNT },
    compose: { appMountTarget: COMPOSE_APP_MOUNT },
    dotnet: { ...http(DOTNET_LISTENER), appMountTarget: DOTNET_APP_MOUNT },
    elasticsearch: { listener: ELASTICSEARCH_LISTENER },
    go: { ...http(GO_LISTENER), appMountTarget: LANGUAGE_APP_MOUNT },
    lando: { appMountTarget: LANDO_APP_MOUNT },
    localstack: http(LOCALSTACK_LISTENER),
    mailhog: { listener: MAILHOG_LISTENER, httpPort: MAILPIT_WEB_PORT },
    mailpit: { listener: MAILPIT_LISTENER, httpPort: MAILPIT_WEB_PORT },
    mariadb: { listener: MARIADB_LISTENER, configTargets: { server: MARIADB_CONFIG_TARGET } },
    meilisearch: http(MEILISEARCH_LISTENER),
    memcached: { listener: MEMCACHED_LISTENER },
    minio: http(MINIO_LISTENER),
    mongodb: { listener: MONGODB_LISTENER, configTargets: { server: MONGODB_CONFIG_TARGET } },
    mssql: { listener: MSSQL_LISTENER },
    mysql: { listener: MYSQL_LISTENER, configTargets: { server: MYSQL_CONFIG_TARGET } },
    nginx: { ...http(NGINX_LISTENER), appMountTarget: NGINX_APP_MOUNT },
    node: { ...http(NODE_LISTENER), appMountTarget: NODE_APP_MOUNT },
    opensearch: http(OPENSEARCH_LISTENER),
    php: { ...http(PHP_LISTENER), appMountTarget: PHP_APP_MOUNT },
    phpmyadmin: { listener: PHPMYADMIN_LISTENER, httpPort: PHPMYADMIN_LISTENER.port },
    postgres: { listener: POSTGRES_LISTENER, configTargets: { server: POSTGRES_CONFIG_TARGET } },
    python: { ...http(PYTHON_LISTENERS.none), appMountTarget: LANGUAGE_APP_MOUNT },
    rabbitmq: { listener: RABBITMQ_LISTENER, httpPort: MANAGEMENT_PORT },
    redis: { listener: REDIS_LISTENER },
    ruby: { ...http(RUBY_LISTENERS.none), appMountTarget: LANGUAGE_APP_MOUNT },
    solr: { ...http(SOLR_LISTENER), configTargets: { dir: SOLR_CONFIG_TARGET } },
    static: { ...http(STATIC_LISTENER), appMountTarget: STATIC_APP_MOUNT },
    tomcat: { ...http(TOMCAT_LISTENER), appMountTarget: TOMCAT_APP_MOUNT },
    valkey: { listener: VALKEY_LISTENER },
    varnish: http(VARNISH_LISTENER),
  };
  const versions = new Map<string, Set<string>>();
  for (const [id, type] of types) {
    const [base = id, version] = id.split(":");
    const published = versions.get(base) ?? new Set<string>();
    for (const item of type.versions ?? []) published.add(item);
    if (version !== undefined) published.add(version);
    versions.set(base, published);
  }
  return Object.fromEntries(
    [...versions].map(([id, published]) => {
      const facts = defaults[id];
      const listener = facts?.listener;
      return [
        id,
        {
          ...facts,
          versions: [...published],
          ...(listener === undefined
            ? {}
            : {
                listener: {
                  port: listener.port,
                  ...(listener.variables?.[0] === undefined ? {} : { variable: listener.variables[0] }),
                },
              }),
        },
      ];
    }),
  );
};
