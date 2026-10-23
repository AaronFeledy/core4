import type { ServiceConnection, ServiceCreds } from "../schema/service-connection.ts";

export type DatabaseFamily = ServiceConnection["family"];

/** Service environment key carrying a database service's planned container listen port. */
export const DATABASE_PORT_ENV_KEY = "LANDO_DB_PORT";

/** Each family's published listen port, used when a service declares no planned port. */
export const DATABASE_FAMILY_DEFAULT_PORTS = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  mongodb: 27017,
  mssql: 1433,
} as const satisfies Record<DatabaseFamily, number>;

/** Native aliases must agree, not override each other; only the service type reads them. */
export const DATABASE_FAMILY_ENV_KEYS = {
  mysql: {
    user: ["MYSQL_USER"],
    password: ["MYSQL_PASSWORD"],
    database: ["MYSQL_DATABASE"],
    rootPassword: ["MYSQL_ROOT_PASSWORD"],
  },
  mariadb: {
    user: ["MYSQL_USER", "MARIADB_USER"],
    password: ["MYSQL_PASSWORD", "MARIADB_PASSWORD"],
    database: ["MYSQL_DATABASE", "MARIADB_DATABASE"],
    rootPassword: ["MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD"],
  },
  postgres: {
    user: ["POSTGRES_USER"],
    password: ["POSTGRES_PASSWORD"],
    database: ["POSTGRES_DB"],
    rootPassword: [],
  },
  mongodb: {
    user: ["MONGO_INITDB_ROOT_USERNAME"],
    password: ["MONGO_INITDB_ROOT_PASSWORD"],
    database: ["MONGO_INITDB_DATABASE"],
    rootPassword: [],
  },
  mssql: {
    user: [],
    password: [],
    database: [],
    rootPassword: ["SA_PASSWORD", "MSSQL_SA_PASSWORD"],
  },
} as const satisfies Record<
  DatabaseFamily,
  { readonly [Field in keyof Required<ServiceCreds>]: readonly string[] }
>;
