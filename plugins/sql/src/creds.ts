import type { SqlFamily } from "./families.ts";

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

type EnvCreds = {
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly database: string | undefined;
  readonly rootPassword: string | undefined;
};

const assertNever = (value: never): never => {
  throw new Error(`unexpected SQL family: ${String(value)}`);
};

const firstEnv = (
  environment: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
): string | undefined => {
  for (const key of keys) {
    const value = environment[key];
    if (value !== undefined) return value;
  }
  return undefined;
};

const envCreds = (family: SqlFamily, environment: Readonly<Record<string, string>>): EnvCreds => {
  switch (family) {
    case "mysql":
      return {
        user: firstEnv(environment, ["MYSQL_USER"]),
        password: firstEnv(environment, ["MYSQL_PASSWORD"]),
        database: firstEnv(environment, ["MYSQL_DATABASE"]),
        rootPassword: firstEnv(environment, ["MYSQL_ROOT_PASSWORD"]),
      };
    case "mariadb":
      return {
        user: firstEnv(environment, ["MYSQL_USER", "MARIADB_USER"]),
        password: firstEnv(environment, ["MYSQL_PASSWORD", "MARIADB_PASSWORD"]),
        database: firstEnv(environment, ["MYSQL_DATABASE", "MARIADB_DATABASE"]),
        rootPassword: firstEnv(environment, ["MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD"]),
      };
    case "postgres":
      return {
        user: firstEnv(environment, ["POSTGRES_USER"]),
        password: firstEnv(environment, ["POSTGRES_PASSWORD"]),
        database: firstEnv(environment, ["POSTGRES_DB"]),
        rootPassword: undefined,
      };
    case "mongodb":
      return {
        user: firstEnv(environment, ["MONGO_INITDB_ROOT_USERNAME"]),
        password: firstEnv(environment, ["MONGO_INITDB_ROOT_PASSWORD"]),
        database: firstEnv(environment, ["MONGO_INITDB_DATABASE"]),
        rootPassword: undefined,
      };
    case "mssql": {
      const saPassword = firstEnv(environment, ["SA_PASSWORD", "MSSQL_SA_PASSWORD"]);
      return { user: undefined, password: saPassword, database: undefined, rootPassword: saPassword };
    }
    default:
      return assertNever(family);
  }
};

const withOptionalRoot = (creds: SqlCreds, rootPassword: string | undefined): SqlCreds =>
  rootPassword === undefined ? creds : { ...creds, rootPassword };

export const resolveSqlCreds = (input: ResolveSqlCredsInput): SqlCreds => {
  const authored = input.landofileService?.creds;
  const fromEnv = envCreds(input.family, input.planEnvironment);
  const defaultUser = input.family === "mssql" ? "sa" : "lando";
  return withOptionalRoot(
    {
      user: authored?.user ?? fromEnv.user ?? defaultUser,
      password: authored?.password ?? fromEnv.password ?? "lando",
      database: authored?.database ?? fromEnv.database ?? input.appName,
    },
    authored?.rootPassword ?? fromEnv.rootPassword,
  );
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
      return assertNever(family);
  }
};
