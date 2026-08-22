import { Effect } from "effect";

import type { DataTransferResult, DataTransferSpec, SnapshotHandle } from "@lando/sdk/schema";

import type { SqlCommandDeps, SqlLandofile, SqlPlan } from "../../src/run.ts";

export type ExtraSqlService = {
  readonly name: string;
  readonly type: string;
};

export type SqlTestOptions = {
  readonly password: string;
  readonly type?: string;
  readonly countStdout?: string;
  readonly countFails?: boolean;
  readonly execFails?: boolean;
  readonly extraServices?: ReadonlyArray<ExtraSqlService>;
  readonly storage?: ReadonlyArray<{ readonly store: string }>;
};

export type RecordedExec = {
  readonly command: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
};

export type RecordedSnapshot = {
  readonly store: string;
  readonly format?: string;
  readonly label?: string;
};

export type SqlTestHarness = {
  readonly deps: SqlCommandDeps;
  readonly transfers: () => ReadonlyArray<DataTransferSpec>;
  readonly snapshots: () => ReadonlyArray<RecordedSnapshot>;
  readonly execs: () => ReadonlyArray<RecordedExec>;
  readonly published: () => ReadonlyArray<string>;
  readonly redactionTokens: () => ReadonlyArray<string>;
};

export const makeSqlTestDeps = (options: SqlTestOptions): SqlTestHarness => {
  const transfers: DataTransferSpec[] = [];
  const snapshots: RecordedSnapshot[] = [];
  const execs: RecordedExec[] = [];
  const published: string[] = [];
  const tokens: string[] = [];
  const storage = options.storage ?? [{ store: "sql-app_database_data" }];
  const services: Record<string, SqlPlan["services"][string]> = {
    database: {
      name: "database",
      type: options.type ?? "mysql:8.0",
      environment: {
        MYSQL_USER: "lando",
        MYSQL_PASSWORD: options.password,
        MYSQL_DATABASE: "sql-app",
      },
      storage,
    },
  };
  for (const extra of options.extraServices ?? []) {
    services[extra.name] = {
      name: extra.name,
      type: extra.type,
      environment: {},
      storage: [{ store: `sql-app_${extra.name}_data` }],
    };
  }

  const landofile: SqlLandofile = {
    name: "sql-app",
    services: Object.fromEntries(
      Object.values(services).map((service) => [service.name, { type: service.type }]),
    ),
  };

  const plan: SqlPlan = {
    id: "sql-app",
    name: "sql-app",
    root: "/tmp/sql-app",
    services,
  };

  const deps: SqlCommandDeps = {
    landofile,
    plan,
    transfer: (spec) =>
      Effect.sync((): DataTransferResult => {
        transfers.push(spec);
        return { accelerated: true, sizeBytes: 12 };
      }),
    snapshot: (store, opts) =>
      Effect.sync((): SnapshotHandle => {
        snapshots.push({
          store: store.store,
          ...(opts?.format === undefined ? {} : { format: opts.format }),
          ...(opts?.label === undefined ? {} : { label: opts.label }),
        });
        return { id: opts?.label ?? `snap-${store.store}`, store };
      }),
    restore: () => Effect.void,
    exec: (_service, command, env) => {
      const joined = command.join(" ");
      const isCount = joined.includes("information_schema") || joined.includes("COUNT(*)");
      if (isCount) {
        if (options.countFails === true) return Effect.succeed({ ok: false, stdout: "" });
        return Effect.succeed({ ok: true, stdout: options.countStdout ?? "0" });
      }
      execs.push({ command, ...(env === undefined ? {} : { env }) });
      return Effect.succeed({ ok: options.execFails !== true, stdout: "" });
    },
    confirm: () => Effect.succeed(false),
    registerSecrets: (secretTokens) =>
      Effect.sync(() => {
        tokens.push(...secretTokens);
      }),
    publish: (event) =>
      Effect.sync(() => {
        published.push(String(event._tag));
      }),
  };

  return {
    deps,
    transfers: () => transfers,
    snapshots: () => snapshots,
    execs: () => execs,
    published: () => published,
    redactionTokens: () => tokens,
  };
};
