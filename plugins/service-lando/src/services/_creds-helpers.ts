import {
  DATABASE_FAMILY_ENV_KEYS,
  DATABASE_PORT_ENV_KEY,
  type DatabaseFamily,
  LANDO_DB_ENV_KEYS,
} from "@lando/sdk/database-creds";
import {
  type Environment,
  type EnvironmentValue,
  type ServiceCreds,
  type ServiceCredsConfig,
  normalizeEnvironmentValue,
} from "@lando/sdk/schema";
import { ServiceConfigIssue } from "./_feature-helpers.ts";

export type CredsFamily = DatabaseFamily;

export type CredsMember = keyof ServiceCreds;

const CREDS_MEMBERS: ReadonlyArray<CredsMember> = ["user", "password", "database", "rootPassword"];

export type CredsApplicability = {
  readonly accepts: ReadonlyArray<CredsMember>;
  readonly message: (member: CredsMember) => string;
  readonly remediation: string;
};

const acceptsEveryMember = (): CredsApplicability => ({
  accepts: CREDS_MEMBERS,
  message: (member) => `creds.${member} is not used by this service type.`,
  remediation: "Remove the unused credential member.",
});

/** Which authored `creds` members a service type reads; a rejected member fails at `creds.<member>`. */
export const DB_CREDS_APPLICABILITY: Readonly<Record<CredsFamily, CredsApplicability>> = {
  mysql: acceptsEveryMember(),
  mariadb: acceptsEveryMember(),
  postgres: {
    accepts: ["user", "password", "database"],
    message: () => "PostgreSQL has no separate root account; creds.password is the superuser password.",
    remediation: "Remove creds.rootPassword and set the superuser password with creds.password.",
  },
  mongodb: {
    accepts: ["user", "password", "database"],
    message: () =>
      "MongoDB has no separate root account; creds.user and creds.password are the root account.",
    remediation: "Remove creds.rootPassword and set the root account with creds.user and creds.password.",
  },
  mssql: acceptsEveryMember(),
};

export const REDIS_CREDS_APPLICABILITY: CredsApplicability = {
  accepts: ["password"],
  message: (member) =>
    member === "rootPassword"
      ? "Redis has no separate root account; creds.password is the only Redis password."
      : "Redis authenticates its single default user with creds.password; there is no per-user or per-database login.",
  remediation: "Remove this member and keep only creds.password.",
};

export const PHPMYADMIN_CREDS_APPLICABILITY: CredsApplicability = {
  accepts: ["user", "password"],
  message: (member) =>
    member === "rootPassword"
      ? "phpMyAdmin has no separate root account; it signs in with creds.user and creds.password."
      : "phpMyAdmin does not select a database; it signs in with creds.user and creds.password.",
  remediation: "Remove this member and keep only creds.user and creds.password.",
};

export const assertCredsApplicability = (
  authored: Partial<ServiceCredsConfig> | undefined,
  applicability: CredsApplicability,
): void => {
  if (authored === undefined) return;
  for (const member of CREDS_MEMBERS) {
    if (authored[member] === undefined || applicability.accepts.includes(member)) continue;
    throw new ServiceConfigIssue(["creds", member], applicability.message(member), applicability.remediation);
  }
};

export type ResolveServiceCredsInput = {
  readonly family: CredsFamily;
  readonly authored?: Partial<ServiceCreds>;
  readonly environment?: Environment;
  readonly defaults: {
    readonly user: string;
    readonly password: string;
    readonly database: string;
    readonly rootPassword?: string;
  };
};

const optionalRoot = (key: string, rootPassword: EnvironmentValue | undefined): Environment =>
  rootPassword === undefined ? {} : { [key]: rootPassword };

export const credentialValuesAgree = (left: EnvironmentValue, right: EnvironmentValue): boolean => {
  const descriptor = (value: EnvironmentValue): string => {
    const normalized = normalizeEnvironmentValue(value);
    if (typeof normalized === "string") return JSON.stringify(normalized);
    switch (normalized._tag) {
      case "SecretRef":
        return JSON.stringify(["ref", normalized.reference]);
      case "BoundText":
        return JSON.stringify([
          "text",
          normalized.parts.map((part) => (typeof part === "string" ? part : [part.reference, part.encoding])),
        ]);
    }
  };
  return descriptor(left) === descriptor(right);
};

export const resolveServiceCreds = (input: ResolveServiceCredsInput): ServiceCreds => {
  assertCredsApplicability(input.authored, DB_CREDS_APPLICABILITY[input.family]);
  const fact = (field: keyof ServiceCreds): EnvironmentValue | undefined => {
    let selected = input.authored?.[field];
    let path = `creds.${field}`;
    for (const key of DATABASE_FAMILY_ENV_KEYS[input.family][field]) {
      const value = input.environment?.[key];
      if (value === undefined) continue;
      const nativePath = `environment.${key}`;
      if (selected !== undefined && !credentialValuesAgree(selected, value)) {
        throw new ServiceConfigIssue(
          ["environment", key],
          `${path} conflicts with ${nativePath}.`,
          "Make both credential descriptors agree or remove one source.",
        );
      }
      selected = value;
      path = nativePath;
    }
    return selected;
  };
  const literal = (field: "user" | "database"): string | undefined => {
    const value = fact(field);
    if (value !== undefined && typeof value !== "string") {
      throw new ServiceConfigIssue(
        ["creds", field],
        `creds.${field} and its native environment aliases must be literal text.`,
      );
    }
    return value;
  };
  const authoredRoot = fact("rootPassword");
  const authoredPassword = fact("password");
  if (input.family === "mssql") {
    const user = literal("user");
    if (user !== undefined && user !== "sa") {
      throw new ServiceConfigIssue(
        ["creds", "user"],
        "creds.user conflicts with the SQL Server image administrator identity sa.",
        "Use user: sa; the image does not create another login.",
      );
    }
    if (
      authoredRoot !== undefined &&
      authoredPassword !== undefined &&
      !credentialValuesAgree(authoredRoot, authoredPassword)
    ) {
      throw new ServiceConfigIssue(
        ["creds", "password"],
        "creds.password conflicts with creds.rootPassword / environment.SA_PASSWORD / environment.MSSQL_SA_PASSWORD.",
        "Use one administrator password descriptor.",
      );
    }
    const password =
      authoredPassword ?? authoredRoot ?? input.defaults.rootPassword ?? input.defaults.password;
    return {
      user: "sa",
      database: literal("database") ?? input.defaults.database,
      password,
      rootPassword: password,
    };
  }
  const rootPassword = authoredRoot ?? input.defaults.rootPassword;
  return {
    user: literal("user") ?? input.defaults.user,
    password: authoredPassword ?? input.defaults.password,
    database: literal("database") ?? input.defaults.database,
    ...optionalRoot("rootPassword", rootPassword),
  };
};

export const familyEnvFor = (family: CredsFamily, creds: ServiceCreds): Environment => {
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
      return {
        SA_PASSWORD: creds.password,
        MSSQL_SA_PASSWORD: creds.password,
        SQLCMDPASSWORD: creds.password,
      };
    default:
      throw new Error(`unexpected creds family: ${String(family satisfies never)}`);
  }
};

export const landoDbEnvFor = (creds: ServiceCreds, port: number): Environment => ({
  [DATABASE_PORT_ENV_KEY]: String(port),
  [LANDO_DB_ENV_KEYS.user]: creds.user,
  [LANDO_DB_ENV_KEYS.password]: creds.password,
  [LANDO_DB_ENV_KEYS.database]: creds.database,
  ...optionalRoot(LANDO_DB_ENV_KEYS.rootPassword, creds.rootPassword),
});
