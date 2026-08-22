import type { SqlCreds } from "./creds.ts";

export type SqlLandofileService = {
  readonly type?: string;
  readonly creds?: SqlCreds;
};

export type SqlLandofile = {
  readonly name?: string;
  readonly services?: Readonly<Record<string, SqlLandofileService | undefined>>;
};

export type SqlPlanService = {
  readonly name: string;
  readonly type: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly storage: ReadonlyArray<{ readonly store: string }>;
};

export type SqlPlan = {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly services: Readonly<Record<string, SqlPlanService>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const authoredCreds = (value: Record<string, unknown>): SqlCreds => {
  const creds: SqlCreds = {
    user: asString(value.user) ?? "lando",
    password: asString(value.password) ?? "lando",
    database: asString(value.database) ?? "lando",
  };
  const rootPassword = asString(value.rootPassword);
  return rootPassword === undefined ? creds : { ...creds, rootPassword };
};

export const toSqlLandofile = (value: unknown): SqlLandofile => {
  if (!isRecord(value)) return {};
  const services = isRecord(value.services) ? value.services : {};
  const name = asString(value.name);
  const mapped: Record<string, SqlLandofileService> = {};
  for (const [serviceName, service] of Object.entries(services)) {
    if (!isRecord(service)) continue;
    const type = asString(service.type);
    const creds = isRecord(service.creds) ? authoredCreds(service.creds) : undefined;
    mapped[serviceName] = {
      ...(type === undefined ? {} : { type }),
      ...(creds === undefined ? {} : { creds }),
    };
  }
  return {
    ...(name === undefined ? {} : { name }),
    services: mapped,
  };
};

export const toSqlPlan = (value: unknown): SqlPlan => {
  const record = isRecord(value) ? value : {};
  const services = isRecord(record.services) ? record.services : {};
  const mapped: Record<string, SqlPlanService> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) continue;
    const environment: Record<string, string> = {};
    if (isRecord(service.environment)) {
      for (const [key, item] of Object.entries(service.environment)) {
        if (typeof item === "string") environment[key] = item;
      }
    }
    const storage = Array.isArray(service.storage)
      ? service.storage.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.store !== "string") return [];
          return [{ store: entry.store }];
        })
      : [];
    mapped[name] = {
      name: asString(service.name) ?? name,
      type: asString(service.type) ?? name,
      environment,
      storage,
    };
  }
  return {
    id: asString(record.id) ?? "app",
    name: asString(record.name) ?? "app",
    root: asString(record.root) ?? "/",
    services: mapped,
  };
};

export const sqlPlanFromLandofile = (landofile: SqlLandofile): SqlPlan => {
  const services: Record<string, SqlPlanService> = {};
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    const type = service?.type;
    if (type === undefined) continue;
    services[name] = { name, type, environment: {}, storage: [] };
  }
  return {
    id: landofile.name ?? "app",
    name: landofile.name ?? "app",
    root: "/",
    services,
  };
};
