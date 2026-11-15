import type { DatabaseConnection, ServiceCreds } from "../schema/database-connection.ts";

export type DatabaseFamily = DatabaseConnection["family"];

/** Service environment key carrying a database service's planned container listen port. */
export const DATABASE_PORT_ENV_KEY = "LANDO_DB_PORT";

/** Published credential tuple shared by database services and their consumers. */
export const LANDO_DB_ENV_KEYS = {
  user: "LANDO_DB_USER",
  password: "LANDO_DB_PASSWORD",
  database: "LANDO_DB_NAME",
  rootPassword: "LANDO_DB_ROOT_PASSWORD",
} as const;

/** Each family's published listen port, used when a service declares no planned port. */
export const DATABASE_FAMILY_DEFAULT_PORTS = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  mongodb: 27017,
  mssql: 1433,
} as const satisfies Record<DatabaseFamily, number>;

/**
 * Arguments every Lando-generated client of a family passes before caller arguments when it
 * connects to 127.0.0.1 inside the database container. MariaDB 11.4+ clients disable server
 * certificate verification on their own for a `MYSQL_PWD` login and warn on every run, so
 * MariaDB clients state that choice explicitly; TLS stays available. MySQL clients reject the
 * option, and remote connections keep verifying the server.
 */
export const DATABASE_FAMILY_LOCAL_CLIENT_ARGS = {
  mysql: [],
  mariadb: ["--skip-ssl-verify-server-cert"],
  postgres: [],
  mongodb: [],
  mssql: [],
} as const satisfies Record<DatabaseFamily, readonly string[]>;

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
