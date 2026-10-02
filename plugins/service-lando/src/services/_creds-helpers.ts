import { type DatabaseFamily, databaseEnvCreds } from "@lando/sdk/database-creds";
import type { ServiceCreds } from "@lando/sdk/schema";

export type CredsFamily = DatabaseFamily;

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

const optionalRoot = (key: string, rootPassword: string | undefined): Readonly<Record<string, string>> =>
  rootPassword === undefined ? {} : { [key]: rootPassword };

export const resolveServiceCreds = (input: ResolveServiceCredsInput): ServiceCreds => {
  const fromEnv = databaseEnvCreds(input.family, input.environment ?? {});
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
      throw new Error(`unexpected creds family: ${String(family satisfies never)}`);
  }
};

export const landoDbEnvFor = (creds: ServiceCreds): Readonly<Record<string, string>> => ({
  LANDO_DB_USER: creds.user,
  LANDO_DB_PASSWORD: creds.password,
  LANDO_DB_NAME: creds.database,
  ...optionalRoot("LANDO_DB_ROOT_PASSWORD", creds.rootPassword),
});
