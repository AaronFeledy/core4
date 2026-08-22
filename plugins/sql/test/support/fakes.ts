import { Effect } from "effect";

import type { DataTransferResult, DataTransferSpec, SnapshotHandle } from "@lando/sdk/schema";

import type { SqlCommandDeps } from "../../src/run.ts";
import type { SqlLandofile, SqlPlan } from "../../src/views.ts";

export type ExtraSqlService = {
  readonly name: string;
  readonly type: string;
};

export type SqlTestOptions = {
  readonly password: string;
  readonly type?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly countStdout?: string;
  readonly countFails?: boolean;
  readonly execFails?: boolean;
  readonly restoreFails?: boolean;
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

export type SqlLifecycleStep = "stop" | "restore" | "start";

export class FakeRestoreError extends Error {
  readonly _tag = "FakeRestoreError";
  constructor() {
    super("restore failed");
    this.name = "FakeRestoreError";
  }
}

export type SqlTestHarness = {
  readonly deps: SqlCommandDeps;
  readonly transfers: () => ReadonlyArray<DataTransferSpec>;
  readonly snapshots: () => ReadonlyArray<RecordedSnapshot>;
  readonly execs: () => ReadonlyArray<RecordedExec>;
  readonly published: () => ReadonlyArray<string>;
  readonly lifecycle: () => ReadonlyArray<SqlLifecycleStep>;
};

export const makeSqlTestDeps = (options: SqlTestOptions): SqlTestHarness => {
  const transfers: DataTransferSpec[] = [];
  const snapshots: RecordedSnapshot[] = [];
  const execs: RecordedExec[] = [];
  const published: string[] = [];
  const lifecycle: SqlLifecycleStep[] = [];
  const storage = options.storage ?? [{ store: "sql-app_database_data" }];
  const services: Record<string, SqlPlan["services"][string]> = {
    database: {
      name: "database",
      type: options.type ?? "mysql:8.0",
      environment: options.environment ?? {
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
    restore: () => {
      lifecycle.push("restore");
      return options.restoreFails === true ? Effect.fail(new FakeRestoreError()) : Effect.void;
    },
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
    start: () =>
      Effect.sync(() => {
        lifecycle.push("start");
      }),
    stop: () =>
      Effect.sync(() => {
        lifecycle.push("stop");
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
    lifecycle: () => lifecycle,
  };
};
