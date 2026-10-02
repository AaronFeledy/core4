/**
 * `@lando/sdk/database-creds`: pure database-family environment credential resolution.
 *
 * This contracts-tier helper reads only the supplied environment, with no Effect
 * or host IO. Consumers own defaults, authored overrides, and outbound env keys.
 */
export type DatabaseFamily = "mysql" | "mariadb" | "postgres" | "mongodb" | "mssql";

export type DatabaseEnvCreds = {
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly database: string | undefined;
  readonly rootPassword: string | undefined;
};

/** Keys are ordered by precedence; SQL Server supplies only a root password. */
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
  { readonly [Field in keyof DatabaseEnvCreds]: readonly string[] }
>;

/** Return the first defined value in key order, including an empty string. */
export const firstEnv = (
  environment: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
): string | undefined => {
  for (const key of keys) {
    const value = environment[key];
    if (value !== undefined) return value;
  }
  return undefined;
};

export const databaseEnvCreds = (
  family: DatabaseFamily,
  environment: Readonly<Record<string, string>>,
): DatabaseEnvCreds => {
  const keys = DATABASE_FAMILY_ENV_KEYS[family];
  return {
    user: firstEnv(environment, keys.user),
    password: firstEnv(environment, keys.password),
    database: firstEnv(environment, keys.database),
    rootPassword: firstEnv(environment, keys.rootPassword),
  };
};
