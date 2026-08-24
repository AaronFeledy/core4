import type { ServiceCreds } from "@lando/sdk/schema";

export type CredsFamily = "mysql" | "mariadb" | "postgres" | "mongodb" | "mssql";

export type ResolveServiceCredsInput = {
  readonly family: CredsFamily;
  readonly authored?: Partial<ServiceCreds>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly defaults: {
    readonly user: string;
    readonly password: string;
    readonly database: string;
    readonly rootPassword?: string;
  };
  readonly topLevelDatabase?: string;
};

type EnvCreds = {
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly database: string | undefined;
  readonly rootPassword: string | undefined;
};

const assertNever = (value: never): never => {
  throw new Error(`unexpected creds family: ${String(value)}`);
};

const firstEnv = (
  environment: Readonly<Record<string, string>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = environment[key];
    if (value !== undefined) return value;
  }
  return undefined;
};

const familyEnvCreds = (family: CredsFamily, environment: Readonly<Record<string, string>>): EnvCreds => {
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
    case "mssql":
      return {
        user: undefined,
        password: undefined,
        database: undefined,
        rootPassword: firstEnv(environment, ["SA_PASSWORD", "MSSQL_SA_PASSWORD"]),
      };
    default:
      return assertNever(family);
  }
};

const optionalRoot = (key: string, rootPassword: string | undefined): Readonly<Record<string, string>> =>
  rootPassword === undefined ? {} : { [key]: rootPassword };

export const resolveServiceCreds = (input: ResolveServiceCredsInput): ServiceCreds => {
  const fromEnv = familyEnvCreds(input.family, input.environment ?? {});
  const rootPassword = input.authored?.rootPassword ?? fromEnv.rootPassword ?? input.defaults.rootPassword;
  return {
    user: input.authored?.user ?? fromEnv.user ?? input.defaults.user,
    password: input.authored?.password ?? fromEnv.password ?? input.defaults.password,
    database:
      input.authored?.database ?? fromEnv.database ?? input.topLevelDatabase ?? input.defaults.database,
    ...optionalRoot("rootPassword", rootPassword),
  };
};

export const familyEnvFor = (family: CredsFamily, creds: ServiceCreds): Readonly<Record<string, string>> => {
  switch (family) {
    case "mysql":
      return {
        MYSQL_USER: creds.user,
        MYSQL_PASSWORD: creds.password,
        MYSQL_DATABASE: creds.database,
        ...optionalRoot("MYSQL_ROOT_PASSWORD", creds.rootPassword),
      };
    case "mariadb":
      return {
        MARIADB_USER: creds.user,
        MARIADB_PASSWORD: creds.password,
        MARIADB_DATABASE: creds.database,
        ...optionalRoot("MARIADB_ROOT_PASSWORD", creds.rootPassword),
        MYSQL_USER: creds.user,
        MYSQL_PASSWORD: creds.password,
        MYSQL_DATABASE: creds.database,
        ...optionalRoot("MYSQL_ROOT_PASSWORD", creds.rootPassword),
      };
    case "postgres":
      return {
        POSTGRES_USER: creds.user,
        POSTGRES_PASSWORD: creds.password,
        POSTGRES_DB: creds.database,
      };
    case "mongodb":
      return {
        MONGO_INITDB_ROOT_USERNAME: creds.user,
        MONGO_INITDB_ROOT_PASSWORD: creds.password,
        MONGO_INITDB_DATABASE: creds.database,
      };
    case "mssql":
      return optionalRoot("SA_PASSWORD", creds.rootPassword);
    default:
      return assertNever(family);
  }
};

export const landoDbEnvFor = (creds: ServiceCreds): Readonly<Record<string, string>> => ({
  LANDO_DB_USER: creds.user,
  LANDO_DB_PASSWORD: creds.password,
  LANDO_DB_NAME: creds.database,
  ...optionalRoot("LANDO_DB_ROOT_PASSWORD", creds.rootPassword),
});
