import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type {
  DataTransferResult,
  DataTransferSpec,
  SnapshotFilter,
  SnapshotHandle,
  SnapshotMetadata,
  VolumeInfo,
} from "@lando/sdk/schema";
import { AbsolutePath, AppId, ServiceName, SnapshotInfo } from "@lando/sdk/schema";

import type { SqlCommandDeps } from "../../src/run.ts";
import type { SqlLandofile, SqlPlan } from "../../src/views.ts";

export type ExtraSqlService = {
  readonly name: string;
  readonly type: string;
};

export type SqlTestOptions = {
  readonly password: string;
  readonly rootPassword?: string;
  readonly type?: string;
  readonly version?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly countStdout?: string;
  readonly countFails?: boolean;
  readonly countFailuresBeforeSuccess?: number;
  readonly execFails?: boolean;
  readonly restoreFails?: boolean;
  readonly startFails?: boolean;
  readonly initiallyRunning?: boolean;
  readonly omitImageIdentity?: boolean;
  readonly extraServices?: ReadonlyArray<ExtraSqlService>;
  readonly storage?: ReadonlyArray<{ readonly store: string }>;
  readonly seedStatus?: "fresh" | "in-progress" | "seeded" | "failed";
  readonly snapshotVersion?: string;
  readonly snapshotVolumeInstance?: string;
};

export type RecordedExec = {
  readonly command: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
};

export type RecordedSnapshot = {
  readonly store: string;
  readonly format?: string;
  readonly label?: string;
  readonly metadata?: SnapshotMetadata;
};

export type SqlLifecycleStep = "lock" | "snapshot" | "stop" | "restore" | "start";

export class FakeRestoreError extends Error {
  readonly _tag = "FakeRestoreError";
  constructor() {
    super("restore failed");
    this.name = "FakeRestoreError";
  }
}

export class FakeStartError extends Error {
  readonly _tag = "FakeStartError";
  constructor() {
    super("start failed");
    this.name = "FakeStartError";
  }
}

export type SqlTestHarness = {
  readonly root: string;
  readonly deps: SqlCommandDeps;
  readonly transfers: () => ReadonlyArray<DataTransferSpec>;
  readonly snapshots: () => ReadonlyArray<RecordedSnapshot>;
  readonly execs: () => ReadonlyArray<RecordedExec>;
  readonly published: () => ReadonlyArray<string>;
  readonly lifecycle: () => ReadonlyArray<SqlLifecycleStep>;
  readonly snapshotFilters: () => ReadonlyArray<SnapshotFilter>;
  readonly countAttempts: () => number;
  readonly dispose: () => void;
};

const liveHarnesses: SqlTestHarness[] = [];

export const makeSqlTestDeps = (options: SqlTestOptions): SqlTestHarness => {
  const transfers: DataTransferSpec[] = [];
  const snapshots: RecordedSnapshot[] = [];
  const execs: RecordedExec[] = [];
  const published: string[] = [];
  const lifecycle: SqlLifecycleStep[] = [];
  const snapshotFilters: SnapshotFilter[] = [];
  let countAttempts = 0;
  let seedStatus = options.seedStatus ?? "fresh";
  const storage = options.storage ?? [{ store: "sql-app_database_data" }];
  const services: Record<string, SqlPlan["services"][string]> = {
    database: {
      name: "database",
      type: options.type ?? "mysql:8.0",
      ...(options.version === undefined ? {} : { version: options.version }),
      environment: options.environment ?? {
        MYSQL_USER: "lando",
        MYSQL_PASSWORD: options.password,
        MYSQL_DATABASE: "sql-app",
        ...(options.rootPassword === undefined ? {} : { MYSQL_ROOT_PASSWORD: options.rootPassword }),
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
      Object.values(services).map((service) => [
        service.name,
        {
          type: service.type,
          ...(options.rootPassword === undefined
            ? {}
            : { creds: { password: options.password, rootPassword: options.rootPassword } }),
        },
      ]),
    ),
  };

  const root = mkdtempSync(join(tmpdir(), "lando-sql-"));
  const plan: SqlPlan = {
    id: "sql-app",
    name: "sql-app",
    root,
    identity: {
      appRoot: root,
      ownerKey: "owner:sql-app",
      repoGroupKey: "repository:sql-app",
    },
    services,
  };

  for (const name of ["dump.sql.gz", "dump.sql", "dump.bak"] as const) {
    writeFileSync(join(plan.root, name), "x");
  }

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
          ...(opts?.metadata === undefined ? {} : { metadata: opts.metadata }),
        });
        lifecycle.push("snapshot");
        return { id: `snap-${store.store}-${snapshots.length}`, store };
      }),
    restore: () => {
      lifecycle.push("restore");
      return options.restoreFails === true ? Effect.fail(new FakeRestoreError()) : Effect.void;
    },
    listSnapshots: (filter) =>
      Effect.sync(() => {
        snapshotFilters.push(filter);
        return filter.id === undefined
          ? []
          : [
              SnapshotInfo.make({
                id: filter.id,
                store: { app: AppId.make("sql-app"), store: storage[0]?.store ?? "" },
                digest: "sha256:test",
                sizeBytes: 12,
                createdAt: DateTime.unsafeMake("2026-09-11T00:00:00Z"),
                metadata: {
                  sourceRoot: AbsolutePath.make(root),
                  ownerKey: plan.identity?.ownerKey ?? "owner:sql-app",
                  service: ServiceName.make("database"),
                  volumeInstanceId:
                    options.snapshotVolumeInstance ?? `volume-instance:${storage[0]?.store ?? ""}`,
                  family: (options.type ?? "mysql:8.0").startsWith("postgres") ? "postgres" : "mysql",
                  version: options.snapshotVersion ?? (options.type ?? "mysql:8.0").split(":")[1] ?? "8.0",
                  imageIdentity: "sha256:mysql-runtime",
                  recoveryReason: "manual",
                },
              }),
            ];
      }),
    canonicalizeSourcePath: (path) =>
      Effect.try({
        try: () => AbsolutePath.make(realpathSync(path)),
        catch: () =>
          new SqlRecoveryUnavailableError({
            message: `Cannot resolve snapshot source path ${path}.`,
            service: "database",
            reason: "The selected source path does not exist or is not accessible.",
            remediation: "Pass an existing app root with --from-path.",
          }),
      }),
    exec: (_service, command, env) => {
      const joined = command.join(" ");
      const isCount = joined.includes("information_schema") || joined.includes("COUNT(*)");
      if (isCount) {
        return Effect.sync(() => {
          countAttempts += 1;
          if (options.countFails === true || countAttempts <= (options.countFailuresBeforeSuccess ?? 0)) {
            return { ok: false, stdout: "" };
          }
          return { ok: true, stdout: options.countStdout ?? "0" };
        });
      }
      execs.push({ command, ...(env === undefined ? {} : { env }) });
      return Effect.succeed({ ok: options.execFails !== true, stdout: "" });
    },
    confirm: () => Effect.succeed(false),
    start: () =>
      Effect.gen(function* () {
        lifecycle.push("start");
        if (options.startFails === true) {
          return yield* Effect.fail(new FakeStartError());
        }
      }),
    stop: () =>
      Effect.sync(() => {
        lifecycle.push("stop");
      }),
    inspect: () =>
      Effect.succeed({
        running: options.initiallyRunning !== false,
        ...(options.omitImageIdentity === true ? {} : { imageIdentity: "sha256:mysql-runtime" }),
      }),
    inspectVolume: (_service, store) =>
      Effect.succeed({
        ref: { app: AppId.make("sql-app"), store },
        instanceId: `volume-instance:${store}`,
        provenance: "known",
      } satisfies VolumeInfo),
    withVolumeLock: (_instanceId, body) =>
      Effect.sync(() => {
        lifecycle.push("lock");
      }).pipe(Effect.zipRight(body)),
    getSeedStatus: () => Effect.succeed(seedStatus),
    setSeedStatus: (_instanceId, status) =>
      Effect.sync(() => {
        seedStatus = status;
      }),
    publish: (event) =>
      Effect.sync(() => {
        published.push(String(event._tag));
      }),
  };

  const harness: SqlTestHarness = {
    root,
    deps,
    transfers: () => transfers,
    snapshots: () => snapshots,
    execs: () => execs,
    published: () => published,
    lifecycle: () => lifecycle,
    snapshotFilters: () => snapshotFilters,
    countAttempts: () => countAttempts,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  liveHarnesses.push(harness);
  return harness;
};

export const cleanupSqlTestDeps = (): void => {
  for (const harness of liveHarnesses.splice(0)) {
    harness.dispose();
  }
};
