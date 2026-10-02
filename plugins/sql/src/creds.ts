import { databaseEnvCreds } from "@lando/sdk/database-creds";

import type { SqlFamily } from "./families.ts";

/** Public fallback credential used by the bundled SQL recipes. */
export const DEFAULT_SQL_PASSWORD = "lando";

export type SqlCreds = {
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly rootPassword?: string;
};

export type ResolveSqlCredsInput = {
  readonly family: SqlFamily;
  readonly serviceName: string;
  readonly appName: string;
  readonly landofileService?: { readonly creds?: Partial<SqlCreds> };
  readonly planEnvironment: Readonly<Record<string, string>>;
};

export const resolveSqlCreds = (input: ResolveSqlCredsInput): SqlCreds => {
  const authored = input.landofileService?.creds;
  const fromEnv = databaseEnvCreds(input.family, input.planEnvironment);
  const password = input.family === "mssql" ? (fromEnv.password ?? fromEnv.rootPassword) : fromEnv.password;
  const defaultUser = input.family === "mssql" ? "sa" : "lando";
  const rootPassword = authored?.rootPassword ?? fromEnv.rootPassword;
  return {
    user: authored?.user ?? fromEnv.user ?? defaultUser,
    password: authored?.password ?? password ?? DEFAULT_SQL_PASSWORD,
    database: authored?.database ?? fromEnv.database ?? input.appName,
    ...(rootPassword === undefined ? {} : { rootPassword }),
  };
};

const mongoUri = (creds: SqlCreds): string =>
  `mongodb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@127.0.0.1:27017/${encodeURIComponent(creds.database)}?authSource=admin`;

export const credsEnv = (family: SqlFamily, creds: SqlCreds): Record<string, string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return { MYSQL_PWD: creds.password };
    case "postgres":
      return { PGPASSWORD: creds.password };
    case "mongodb":
      return { MONGO_URI: mongoUri(creds) };
    case "mssql": {
      const secret = creds.rootPassword ?? creds.password;
      return {
        SQLCMDPASSWORD: secret,
        SA_PASSWORD: secret,
        MSSQL_SA_PASSWORD: secret,
      };
    }
    default:
      throw new Error(`unexpected SQL family: ${String(family satisfies never)}`);
  }
};
