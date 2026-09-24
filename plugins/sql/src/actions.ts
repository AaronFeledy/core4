import { Effect } from "effect";

import { SqlCommandFailedError, type VolumeNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type DataTransferResult,
  type DataTransferSpec,
  PortablePath,
  type PrunePolicy,
  ServiceName,
  type SnapshotFilter,
  type SnapshotHandle,
  type SnapshotId,
  type SnapshotInfo,
  type SnapshotOptions,
  type VolumeRef,
} from "@lando/sdk/schema";

import type { DumpCompression } from "./compression.ts";
import { withHostDumpCompression } from "./compression.ts";
import type { SqlCreds } from "./creds.ts";
import {
  type SqlFamily,
  dumpCommand,
  loadCommand,
  mssqlBackupCommand,
  mssqlBackupServicePath,
  mssqlPrepareBackupCommand,
  mssqlRestoreCommand,
  resetCommand,
} from "./families.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";
import { requireDatabaseMount } from "./volume-target.ts";

export type SqlExec = (
  service: string,
  command: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) => Effect.Effect<{ readonly ok: boolean; readonly stdout: string }, unknown>;

export type SqlMover = {
  readonly transfer: (spec: DataTransferSpec) => Effect.Effect<DataTransferResult, unknown>;
  readonly snapshot: (store: VolumeRef, opts?: SnapshotOptions) => Effect.Effect<SnapshotHandle, unknown>;
  readonly restore: (id: string, store: VolumeRef) => Effect.Effect<void, unknown>;
  readonly listSnapshots: (filter: SnapshotFilter) => Effect.Effect<ReadonlyArray<SnapshotInfo>, unknown>;
  readonly pruneSnapshots: (policy: PrunePolicy) => Effect.Effect<ReadonlyArray<SnapshotId>, unknown>;
};

export const requireVolume = (
  plan: SqlPlan,
  service: SqlPlanService,
  _name: string,
): Effect.Effect<VolumeRef, VolumeNotFoundError> =>
  requireDatabaseMount(service, plan.id).pipe(
    Effect.map((mount) => ({ app: AppId.make(plan.id), store: mount.store })),
  );

const requireExecOk = (
  result: { readonly ok: boolean },
  service: string,
  command: ReadonlyArray<string>,
): Effect.Effect<void, SqlCommandFailedError> =>
  result.ok
    ? Effect.void
    : Effect.fail(
        new SqlCommandFailedError({
          message: `Database command failed in ${service}.`,
          service,
          command,
          remediation: "Inspect the service logs, then retry the import, export, or reset.",
        }),
      );

export const runExport = (
  mover: SqlMover,
  exec: SqlExec,
  input: {
    readonly plan: SqlPlan;
    readonly service: string;
    readonly family: SqlFamily;
    readonly creds: SqlCreds;
    readonly env: Readonly<Record<string, string>>;
    readonly file: string;
    readonly compression: DumpCompression;
  },
) => {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  return withHostDumpCompression({
    path: input.file,
    compression: input.compression,
    direction: "export",
    transfer: (workingPath) => {
      const path = AbsolutePath.make(workingPath);
      if (input.family === "mssql") {
        const bak = mssqlBackupServicePath(input.creds.database);
        const backup = mssqlBackupCommand(input.creds.database);
        return Effect.gen(function* () {
          const prepare = mssqlPrepareBackupCommand();
          yield* requireExecOk(yield* exec(input.service, prepare, input.env), input.service, prepare);
          yield* requireExecOk(yield* exec(input.service, backup, input.env), input.service, backup);
          return yield* mover.transfer({
            from: {
              _tag: "servicePath",
              app,
              service,
              path: PortablePath.make(bak),
            },
            to: { _tag: "hostPath", path },
            overwrite: true,
          });
        });
      }
      return mover.transfer({
        from: {
          _tag: "serviceCmd",
          app,
          service,
          command: dumpCommand(input.family, input.creds),
          env: input.env,
        },
        to: { _tag: "hostPath", path },
        overwrite: true,
      });
    },
  });
};

export const runImport = (
  mover: SqlMover,
  exec: SqlExec,
  input: {
    readonly plan: SqlPlan;
    readonly service: string;
    readonly family: SqlFamily;
    readonly creds: SqlCreds;
    readonly env: Readonly<Record<string, string>>;
    readonly file: string;
    readonly compression: DumpCompression;
    readonly expectedDigest?: string;
  },
) => {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  return withHostDumpCompression({
    path: input.file,
    compression: input.compression,
    direction: "import",
    ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
    transfer: (workingPath, digest) => {
      const path = AbsolutePath.make(workingPath);
      if (input.family === "mssql") {
        const bak = mssqlBackupServicePath(input.creds.database);
        return Effect.gen(function* () {
          const prepare = mssqlPrepareBackupCommand();
          yield* requireExecOk(yield* exec(input.service, prepare, input.env), input.service, prepare);
          const transfer = yield* mover.transfer({
            from: { _tag: "hostPath", path, trusted: true },
            to: {
              _tag: "servicePath",
              app,
              service,
              path: PortablePath.make(bak),
            },
            overwrite: true,
            ...(digest === undefined ? {} : { expectedDigest: digest }),
          });
          const restore = mssqlRestoreCommand(input.creds.database);
          yield* requireExecOk(yield* exec(input.service, restore, input.env), input.service, restore);
          return transfer;
        });
      }
      return mover.transfer({
        from: { _tag: "hostPath", path, trusted: true },
        to: {
          _tag: "serviceCmd",
          app,
          service,
          command: loadCommand(input.family, input.creds),
          env: input.env,
        },
        overwrite: true,
        ...(digest === undefined ? {} : { expectedDigest: digest }),
      });
    },
  });
};

export const runReset = (
  exec: SqlExec,
  service: string,
  family: SqlFamily,
  creds: SqlCreds,
  env: Readonly<Record<string, string>>,
) => {
  const usesMysqlRoot = (family === "mysql" || family === "mariadb") && creds.rootPassword !== undefined;
  const command = resetCommand(family, usesMysqlRoot ? { user: "root", database: creds.database } : creds);
  const resetEnv = usesMysqlRoot ? { ...env, MYSQL_PWD: creds.rootPassword } : env;
  return exec(service, command, resetEnv).pipe(
    Effect.flatMap((result) => requireExecOk(result, service, command)),
  );
};
