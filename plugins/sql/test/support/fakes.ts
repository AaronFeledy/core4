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
  VolumeInfo,
  VolumeInitializationRecord,
} from "@lando/sdk/schema";
import { AbsolutePath, AppId, ServiceName, SnapshotInfo } from "@lando/sdk/schema";

import type { SqlCommandDeps } from "../../src/run.ts";
import type { SqlLandofile, SqlPlan } from "../../src/views.ts";
import { FakeRestoreError, FakeStartError } from "./errors.ts";
import {
  type RecordedExec,
  type RecordedSnapshot,
  type SqlLifecycleStep,
  type SqlTestHarness,
  type SqlTestOptions,
  fixtureDataDestination,
} from "./types.ts";
export type * from "./types.ts";
export { FakeRestoreError, FakeStartError } from "./errors.ts";

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
  let seedOperationId = "fixture-operation";
  let runtimeRunning = options.initiallyRunning !== false;
  const storage = options.storage ?? [
    { store: "sql-app_database_data", target: fixtureDataDestination(options.type ?? "mysql:8.0") },
  ];
  const services: Record<string, SqlPlan["services"][string]> = {
    database: {
      name: "database",
      type: options.type ?? "mysql:8.0",
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
      storage: [{ store: `sql-app_${extra.name}_data`, target: fixtureDataDestination(extra.type) }],
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
    writeFileSync(join(plan.root, name), name.endsWith(".gz") ? Buffer.from([0x1f, 0x8b, 0x08, 0x00]) : "x");
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
    pruneSnapshots: () => Effect.succeed([]),
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
      const isVersion =
        joined.includes("SELECT VERSION()") ||
        joined.includes("SHOW server_version") ||
        joined.includes("db.version()") ||
        joined.includes("SERVERPROPERTY('ProductVersion')");
      const isCount = joined.includes("information_schema") || joined.includes("COUNT(*)");
      if (isVersion) {
        execs.push({ command, ...(env === undefined ? {} : { env }) });
        return Effect.succeed({ ok: true, stdout: options.observedVersion ?? "8.0" });
      }
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
    resume: () =>
      Effect.gen(function* () {
        lifecycle.push("resume");
        if (options.startFails === true) return yield* Effect.fail(new FakeStartError());
        runtimeRunning = true;
      }),
    suspend: () =>
      Effect.sync(() => {
        lifecycle.push("suspend");
        runtimeRunning = false;
      }),
    inspect: () =>
      Effect.succeed({
        status: options.runtimeExists === false ? "missing" : runtimeRunning ? "running" : "stopped",
        running: runtimeRunning,
        ...(options.runtimeExists === false
          ? {}
          : { containerId: options.containerId ?? "container:database" }),
        ...(options.omitImageIdentity === true ? {} : { imageIdentity: "sha256:mysql-runtime" }),
      }),
    inspectVolume: (_service, store) =>
      Effect.succeed({
        ref: { app: AppId.make("sql-app"), store },
        instanceId: `volume-instance:${store}`,
        provenance: "known",
        identity: {
          coordinationKey: `daemon:${store}`,
          nativeName: store,
          generation: `volume-instance:${store}`,
          ownerRoot: AbsolutePath.make(root),
          origin: "created",
        },
      } satisfies VolumeInfo),
    withVolumeLock: (_instanceId, body) =>
      Effect.sync(() => {
        lifecycle.push("lock");
      }).pipe(Effect.zipRight(body)),
    initialization: (identity) =>
      Effect.succeed({
        read: Effect.sync(
          (): VolumeInitializationRecord => ({
            identity,
            state:
              seedStatus === "fresh" ? { _tag: "fresh" } : { _tag: seedStatus, operationId: seedOperationId },
          }),
        ),
        begin: (operationId) =>
          Effect.sync(() => {
            if (seedStatus !== "fresh") return false;
            seedStatus = "in-progress";
            seedOperationId = operationId;
            return true;
          }),
        finish: ({ operationId, outcome }) =>
          Effect.sync(() => {
            if (seedStatus !== "in-progress" || operationId !== seedOperationId) return false;
            seedStatus = outcome;
            return true;
          }),
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
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  liveHarnesses.push(harness);
  return harness;
};

export const cleanupSqlTestDeps = (): void => {
  for (const harness of liveHarnesses.splice(0)) {
    harness.dispose();
  }
};
