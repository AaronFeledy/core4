import type { ServiceType } from "@lando/sdk/services";
import { MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "./mailpit-constants.ts";
import { APP_MOUNT_TARGET as LANGUAGE_APP_MOUNT } from "./services/_language-runtime.ts";
import { APP_MOUNT_TARGET as APACHE_APP_MOUNT, DEFAULT_PORT as APACHE_PORT } from "./services/apache.ts";
import { APP_MOUNT_TARGET as COMPOSE_APP_MOUNT } from "./services/compose.ts";
import { APP_MOUNT_TARGET as DOTNET_APP_MOUNT, DEFAULT_PORT as DOTNET_PORT } from "./services/dotnet.ts";
import { DEFAULT_PORT as ELASTICSEARCH_PORT } from "./services/elasticsearch.ts";
import { DEFAULT_PORT as GO_PORT } from "./services/go.ts";
import { APP_MOUNT_TARGET as LANDO_APP_MOUNT } from "./services/lando.ts";
import { DEFAULT_PORT as LOCALSTACK_PORT } from "./services/localstack.ts";
import { MARIADB_CONFIG_TARGET, MARIADB_LISTENER } from "./services/mariadb.ts";
import { DEFAULT_PORT as MEILISEARCH_PORT } from "./services/meilisearch.ts";
import { DEFAULT_PORT as MEMCACHED_PORT } from "./services/memcached.ts";
import { DEFAULT_API_PORT as MINIO_PORT } from "./services/minio.ts";
import { MONGODB_CONFIG_TARGET, DEFAULT_PORT as MONGODB_PORT } from "./services/mongodb.ts";
import { MSSQL_LISTENER } from "./services/mssql.ts";
import { MYSQL_CONFIG_TARGET, MYSQL_LISTENER } from "./services/mysql.ts";
import { APP_MOUNT_TARGET as NGINX_APP_MOUNT, DEFAULT_PORT as NGINX_PORT } from "./services/nginx.ts";
import { APP_MOUNT_TARGET as NODE_APP_MOUNT, DEFAULT_PORT as NODE_PORT } from "./services/node.ts";
import { DEFAULT_PORT as OPENSEARCH_PORT } from "./services/opensearch.ts";
import { PHP_APACHE_PORT } from "./services/php-via.ts";
import { APP_MOUNT_TARGET as PHP_APP_MOUNT } from "./services/php.ts";
import { PHPMYADMIN_LISTENER } from "./services/phpmyadmin.ts";
import { POSTGRES_CONFIG_TARGET, POSTGRES_LISTENER } from "./services/postgres.ts";
import { FRAMEWORK_PRESETS as PYTHON_PRESETS } from "./services/python.ts";
import { MANAGEMENT_PORT, RABBITMQ_LISTENER } from "./services/rabbitmq.ts";
import { DEFAULT_PORT as REDIS_PORT } from "./services/redis.ts";
import { FRAMEWORK_PRESETS as RUBY_PRESETS } from "./services/ruby.ts";
import { SOLR_CONFIG_TARGET, DEFAULT_PORT as SOLR_PORT } from "./services/solr.ts";
import { APP_MOUNT_TARGET as STATIC_APP_MOUNT, DEFAULT_PORT as STATIC_PORT } from "./services/static.ts";
import { APP_MOUNT_TARGET as TOMCAT_APP_MOUNT, DEFAULT_PORT as TOMCAT_PORT } from "./services/tomcat.ts";
import { DEFAULT_PORT as VALKEY_PORT } from "./services/valkey.ts";
import { DEFAULT_PORT as VARNISH_PORT } from "./services/varnish.ts";

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
  const http = (port: number) => ({ listener: { port }, httpPort: port });
  const defaults: Readonly<Record<string, Omit<ServiceTypeFacts, "versions">>> = {
    apache: { ...http(APACHE_PORT), appMountTarget: APACHE_APP_MOUNT },
    compose: { appMountTarget: COMPOSE_APP_MOUNT },
    dotnet: { ...http(DOTNET_PORT), appMountTarget: DOTNET_APP_MOUNT },
    elasticsearch: { listener: { port: ELASTICSEARCH_PORT } },
    go: { ...http(GO_PORT), appMountTarget: LANGUAGE_APP_MOUNT },
    lando: { appMountTarget: LANDO_APP_MOUNT },
    localstack: http(LOCALSTACK_PORT),
    mailhog: { listener: { port: MAILPIT_SMTP_PORT }, httpPort: MAILPIT_WEB_PORT },
    mailpit: { listener: { port: MAILPIT_SMTP_PORT }, httpPort: MAILPIT_WEB_PORT },
    mariadb: { listener: MARIADB_LISTENER, configTargets: { server: MARIADB_CONFIG_TARGET } },
    meilisearch: http(MEILISEARCH_PORT),
    memcached: { listener: { port: MEMCACHED_PORT } },
    minio: http(MINIO_PORT),
    mongodb: { listener: { port: MONGODB_PORT }, configTargets: { server: MONGODB_CONFIG_TARGET } },
    mssql: { listener: MSSQL_LISTENER },
    mysql: { listener: MYSQL_LISTENER, configTargets: { server: MYSQL_CONFIG_TARGET } },
    nginx: { ...http(NGINX_PORT), appMountTarget: NGINX_APP_MOUNT },
    node: { ...http(NODE_PORT), appMountTarget: NODE_APP_MOUNT },
    opensearch: http(OPENSEARCH_PORT),
    php: { ...http(PHP_APACHE_PORT), appMountTarget: PHP_APP_MOUNT },
    phpmyadmin: { listener: PHPMYADMIN_LISTENER, httpPort: PHPMYADMIN_LISTENER.port },
    postgres: { listener: POSTGRES_LISTENER, configTargets: { server: POSTGRES_CONFIG_TARGET } },
    python: { ...http(PYTHON_PRESETS.none.port), appMountTarget: LANGUAGE_APP_MOUNT },
    rabbitmq: { listener: RABBITMQ_LISTENER, httpPort: MANAGEMENT_PORT },
    redis: { listener: { port: REDIS_PORT } },
    ruby: { ...http(RUBY_PRESETS.none.port), appMountTarget: LANGUAGE_APP_MOUNT },
    solr: { ...http(SOLR_PORT), configTargets: { dir: SOLR_CONFIG_TARGET } },
    static: { ...http(STATIC_PORT), appMountTarget: STATIC_APP_MOUNT },
    tomcat: { ...http(TOMCAT_PORT), appMountTarget: TOMCAT_APP_MOUNT },
    valkey: { listener: { port: VALKEY_PORT } },
    varnish: http(VARNISH_PORT),
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
                  ...(listener.variable === undefined ? {} : { variable: listener.variable }),
                },
              }),
        },
      ];
    }),
  );
};
