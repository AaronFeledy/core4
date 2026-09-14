import { Effect } from "effect";

import { SqlCommandFailedError, type VolumeNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type DataTransferResult,
  type DataTransferSpec,
  PortablePath,
  ServiceName,
  type SnapshotFilter,
  type SnapshotHandle,
  type SnapshotInfo,
  type SnapshotOptions,
  type VolumeRef,
} from "@lando/sdk/schema";

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
import { wrapExportCommand, wrapImportCommand } from "./gzip.ts";
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
    readonly gzip: boolean;
  },
) => {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  const path = AbsolutePath.make(input.file);
  if (input.family === "mssql") {
    const bak = mssqlBackupServicePath(input.creds.database);
    const backup = mssqlBackupCommand(input.creds.database);
    return Effect.gen(function* () {
      const prepare = mssqlPrepareBackupCommand();
      yield* requireExecOk(yield* exec(input.service, prepare, input.env), input.service, prepare);
      yield* requireExecOk(yield* exec(input.service, backup, input.env), input.service, backup);
      if (input.gzip) {
        const gzip = ["gzip", bak] as const;
        yield* requireExecOk(yield* exec(input.service, gzip, input.env), input.service, gzip);
      }
      return yield* mover.transfer({
        from: {
          _tag: "servicePath",
          app,
          service,
          path: PortablePath.make(input.gzip ? `${bak}.gz` : bak),
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
      command: wrapExportCommand(dumpCommand(input.family, input.creds), input.gzip),
      env: input.env,
    },
    to: { _tag: "hostPath", path },
    overwrite: true,
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
    readonly gzip: boolean;
    readonly expectedDigest?: string;
  },
) => {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  const path = AbsolutePath.make(input.file);
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
          path: PortablePath.make(input.gzip ? `${bak}.gz` : bak),
        },
        overwrite: true,
        ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
      });
      if (input.gzip) {
        const gunzip = ["gunzip", "-f", `${bak}.gz`] as const;
        yield* requireExecOk(yield* exec(input.service, gunzip, input.env), input.service, gunzip);
      }
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
      command: wrapImportCommand(loadCommand(input.family, input.creds), input.gzip),
      env: input.env,
    },
    overwrite: true,
    ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
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
