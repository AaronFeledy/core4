import { AbsolutePath, DatabaseConnection, Environment, planAppIdentity } from "@lando/sdk/schema";
import { Schema } from "effect";
import { Predicate } from "effect";
import type { SqlCreds } from "./creds.ts";

export type SqlLandofileService = {
  readonly type?: string;
  readonly creds?: Partial<SqlCreds>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly sqlite?: { readonly path: string };
};

export type SqlLandofile = {
  readonly name?: string;
  readonly services?: Readonly<Record<string, SqlLandofileService | undefined>>;
};

export type SqlPlanMount =
  | {
      readonly type: "bind";
      readonly source: string;
      readonly target: string;
      readonly readOnly: boolean;
      readonly role?: "app";
    }
  | { readonly type: "volume"; readonly store: string; readonly target: string; readonly readOnly: boolean }
  | { readonly type: "tmpfs"; readonly target: string };

export type SqlPlanService = {
  readonly name: string;
  readonly type: string;
  readonly environment: Environment;
  readonly connection?: DatabaseConnection;
  readonly sqlite?: { readonly path: string };
  readonly user?: string;
  readonly mounts: ReadonlyArray<SqlPlanMount>;
  readonly storage: ReadonlyArray<{ readonly store: string; readonly target?: string }>;
};

export type SqlPlan = {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly identity?: {
    readonly appRoot: string;
    readonly ownerKey: string;
    readonly repoGroupKey?: string;
  };
  readonly services: Readonly<Record<string, SqlPlanService>>;
};

export const sqlPlanIdentity = (plan: SqlPlan) =>
  planAppIdentity({
    root: AbsolutePath.make(plan.root),
    ...(plan.identity === undefined
      ? {}
      : { identity: { ...plan.identity, appRoot: AbsolutePath.make(plan.identity.appRoot) } }),
  });

const objectOrArray = Predicate.or(Predicate.isObject, (value: unknown): value is Record<string, unknown> =>
  Array.isArray(value),
);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const authoredCreds = (value: Record<string, unknown>): Partial<SqlCreds> | undefined => {
  const user = asString(value.user);
  const password = asString(value.password);
  const database = asString(value.database);
  const rootPassword = asString(value.rootPassword);
  const creds: Partial<SqlCreds> = {
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
    ...(database === undefined ? {} : { database }),
    ...(rootPassword === undefined ? {} : { rootPassword }),
  };
  return Object.keys(creds).length === 0 ? undefined : creds;
};

export const toSqlLandofile = (value: unknown): SqlLandofile => {
  if (!objectOrArray(value)) return {};
  const services = objectOrArray(value.services) ? value.services : {};
  const name = asString(value.name);
  const mapped: Record<string, SqlLandofileService> = {};
  for (const [serviceName, service] of Object.entries(services)) {
    if (!objectOrArray(service)) continue;
    const type = asString(service.type);
    const creds = objectOrArray(service.creds) ? authoredCreds(service.creds) : undefined;
    const environment = objectOrArray(service.environment)
      ? Object.fromEntries(
          Object.entries(service.environment).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    const sqlitePath =
      objectOrArray(service.sqlite) && typeof service.sqlite.path === "string" ? service.sqlite.path : undefined;
    mapped[serviceName] = {
      ...(type === undefined ? {} : { type }),
      ...(creds === undefined ? {} : { creds }),
      ...(environment === undefined ? {} : { environment }),
      ...(sqlitePath === undefined ? {} : { sqlite: { path: sqlitePath } }),
    };
  }
  return {
    ...(name === undefined ? {} : { name }),
    services: mapped,
  };
};

export const toSqlPlan = (value: unknown): SqlPlan => {
  const record = objectOrArray(value) ? value : {};
  const identityRecord = objectOrArray(record.identity) ? record.identity : undefined;
  const identityAppRoot = identityRecord === undefined ? undefined : asString(identityRecord.appRoot);
  const identityOwnerKey = identityRecord === undefined ? undefined : asString(identityRecord.ownerKey);
  const identityRepoGroupKey =
    identityRecord === undefined ? undefined : asString(identityRecord.repoGroupKey);
  const identity =
    identityAppRoot === undefined || identityOwnerKey === undefined
      ? undefined
      : {
          appRoot: identityAppRoot,
          ownerKey: identityOwnerKey,
          ...(identityRepoGroupKey === undefined ? {} : { repoGroupKey: identityRepoGroupKey }),
        };
  const services = objectOrArray(record.services) ? record.services : {};
  const mapped: Record<string, SqlPlanService> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!objectOrArray(service)) continue;
    const environment = Schema.decodeUnknownSync(Environment)(
      Object.fromEntries(Object.entries(objectOrArray(service.environment) ? service.environment : {})),
    );
    // Volume entries live on ServicePlan.mounts; keep a narrow storage projection for SQL.
    const plannedMounts = Array.isArray(service.mounts) ? service.mounts : [];
    const storage = plannedMounts.flatMap((entry) => {
      if (!objectOrArray(entry) || entry.type !== "volume" || typeof entry.store !== "string") return [];
      const target = asString(entry.target);
      return [{ store: entry.store, ...(target === undefined ? {} : { target }) }];
    });
    const sqlitePath =
      objectOrArray(service.sqlite) && typeof service.sqlite.path === "string" ? service.sqlite.path : undefined;
    const mounts: SqlPlanMount[] = plannedMounts.flatMap((entry): SqlPlanMount[] => {
      if (!objectOrArray(entry) || typeof entry.type !== "string" || typeof entry.target !== "string") return [];
      if (entry.type === "bind" && typeof entry.source === "string") {
        return [
          {
            type: "bind" as const,
            source: entry.source,
            target: entry.target,
            readOnly: entry.readOnly === true,
            ...(entry.role === "app" ? { role: "app" as const } : {}),
          },
        ];
      }
      if (entry.type === "volume" && typeof entry.store === "string") {
        return [
          {
            type: "volume" as const,
            store: entry.store,
            target: entry.target,
            readOnly: entry.readOnly === true,
          },
        ];
      }
      if (entry.type === "tmpfs") return [{ type: "tmpfs" as const, target: entry.target }];
      return [];
    });
    mapped[name] = {
      name: asString(service.name) ?? name,
      type: asString(service.type) ?? name,
      environment,
      ...(service.connection === undefined
        ? {}
        : { connection: Schema.decodeUnknownSync(DatabaseConnection)(service.connection) }),
      ...(sqlitePath === undefined ? {} : { sqlite: { path: sqlitePath } }),
      ...(typeof service.user === "string" ? { user: service.user } : {}),
      mounts,
      storage,
    };
  }
  return {
    id: asString(record.id) ?? "app",
    name: asString(record.name) ?? "app",
    root: asString(record.root) ?? "/",
    ...(identity === undefined ? {} : { identity }),
    services: mapped,
  };
};

export const overlaySqliteFromLandofile = (plan: SqlPlan, landofile: SqlLandofile): SqlPlan => {
  const services: Record<string, SqlPlanService> = { ...plan.services };
  for (const [name, authored] of Object.entries(landofile.services ?? {})) {
    const sqlite = authored?.sqlite;
    const existing = services[name];
    if (sqlite === undefined || existing === undefined) continue;
    services[name] = { ...existing, sqlite };
  }
  return { ...plan, services };
};

export const sqlPlanFromLandofile = (landofile: SqlLandofile): SqlPlan => {
  const services: Record<string, SqlPlanService> = {};
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    const type = service?.type;
    if (service === undefined || type === undefined) continue;
    services[name] = {
      name,
      type,
      environment: {},
      mounts: [],
      storage: [],
      ...(service.sqlite === undefined ? {} : { sqlite: service.sqlite }),
    };
  }
  return {
    id: landofile.name ?? "app",
    name: landofile.name ?? "app",
    root: "/",
    services,
  };
};
