import type { VolumeNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type DataEndpoint,
  type DataTransferResult,
  type DataTransferSpec,
  type Environment,
  PortablePath,
  type PrunePolicy,
  ServiceName,
  type SnapshotFilter,
  type SnapshotHandle,
  type SnapshotId,
  type SnapshotInfo,
  type SnapshotOptions,
  type SnapshotRestoreOptions,
  type VolumeRef,
} from "@lando/sdk/schema";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, type Scope, Stream } from "effect";
import { checkedSqlExecution } from "./checked-execution.ts";

import type { DumpCompression } from "./compression.ts";
import { compressDumpStream, withHostDumpCompression } from "./compression.ts";
import type { SqlCreds } from "./creds.ts";
import { type SqlCredentialSecrets, resolveSqlEnvironment } from "./environment.ts";
import { type SqlFamily, dumpCommand, loadCommand, resetCommand } from "./families.ts";
import {
  mssqlBackupCommand,
  mssqlBackupServicePath,
  mssqlPrepareBackupCommand,
  mssqlRestoreCommand,
} from "./mssql.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";
import { sqlPlanDataId } from "./views.ts";
import { requireDatabaseMount } from "./volume-target.ts";

export type SqlExec = (
  service: string,
  command: ReadonlyArray<string>,
  env?: Environment,
) => Stream.Stream<ExecChunk, unknown, Scope.Scope>;

export type SqlMover = {
  readonly transfer: (spec: DataTransferSpec) => Effect.Effect<DataTransferResult, unknown>;
  readonly read: (from: DataEndpoint) => Stream.Stream<Uint8Array, unknown, Scope.Scope>;
  readonly snapshot: (store: VolumeRef, opts?: SnapshotOptions) => Effect.Effect<SnapshotHandle, unknown>;
  readonly restore: (
    handle: SnapshotHandle,
    store: VolumeRef,
    opts?: SnapshotRestoreOptions,
  ) => Effect.Effect<void, unknown>;
  readonly listSnapshots: (filter: SnapshotFilter) => Effect.Effect<ReadonlyArray<SnapshotInfo>, unknown>;
  readonly resolveSnapshot: (
    reference: string,
    scope: SnapshotFilter,
  ) => Effect.Effect<SnapshotInfo, unknown>;
  readonly pruneSnapshots: (policy: PrunePolicy) => Effect.Effect<ReadonlyArray<SnapshotId>, unknown>;
};

export const requireVolume = (
  plan: SqlPlan,
  service: SqlPlanService,
  _name: string,
): Effect.Effect<VolumeRef, VolumeNotFoundError> =>
  requireDatabaseMount(service, plan.id).pipe(
    Effect.map((mount) => ({ app: sqlPlanDataId(plan), store: mount.store })),
  );

export type ExportDestination =
  | { readonly _tag: "file"; readonly path: string }
  | { readonly _tag: "stdout"; readonly write: (chunk: Uint8Array) => Effect.Effect<void> };

export const runExport = Effect.fn("Sql.export")(function* (
  mover: SqlMover,
  exec: SqlExec,
  input: {
    readonly plan: SqlPlan;
    readonly service: string;
    readonly family: SqlFamily;
    readonly creds: SqlCreds;
    readonly env: Environment;
    readonly secrets: () => SqlCredentialSecrets;
    readonly destination: ExportDestination;
    readonly compression: DumpCompression;
    readonly compressionLevel?: number;
  },
) {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  // SQL Server writes its backup inside the service first; other families stream the dump client.
  const dumpSource = Effect.fn("Sql.export.source")(function* () {
    if (input.family === "mssql") {
      const prepare = mssqlPrepareBackupCommand(input.creds.database);
      yield* checkedSqlExecution(exec(input.service, prepare, input.env), {
        ...input,
        command: prepare,
        stdout: "discard",
      });
      const backup = mssqlBackupCommand(input.creds.database, input.creds.port);
      yield* checkedSqlExecution(exec(input.service, backup, input.env), {
        ...input,
        command: backup,
        stdout: "discard",
      });
      return {
        _tag: "servicePath",
        app,
        service,
        path: PortablePath.make(mssqlBackupServicePath(input.creds.database)),
      } satisfies DataEndpoint;
    }
    return {
      _tag: "serviceCmd",
      app,
      service,
      command: dumpCommand(input.family, input.creds),
      env: yield* resolveSqlEnvironment(input.env),
      secrets: input.secrets(),
    } satisfies DataEndpoint;
  });
  const destination = input.destination;
  if (destination._tag === "stdout") {
    const source = mover.read(yield* dumpSource());
    const body =
      input.compression === "none"
        ? source
        : compressDumpStream(source, input.compression, input.compressionLevel);
    let sizeBytes = 0;
    yield* Stream.runForEach(body, (chunk) =>
      Effect.suspend(() => {
        sizeBytes += chunk.byteLength;
        return destination.write(chunk);
      }),
    );
    return { accelerated: false, sizeBytes } satisfies DataTransferResult;
  }
  return yield* withHostDumpCompression({
    path: destination.path,
    compression: input.compression,
    ...(input.compressionLevel === undefined ? {} : { compressionLevel: input.compressionLevel }),
    transfer: (workingPath) =>
      dumpSource().pipe(
        Effect.flatMap((from) =>
          mover.transfer({
            from,
            to: { _tag: "hostPath", path: AbsolutePath.make(workingPath) },
            overwrite: true,
          }),
        ),
      ),
  });
});

/** Imports a prepared plaintext dump (see prepareImportDump); `expectedDigest` guards it until transfer. */
export const runImport = Effect.fn("Sql.import")(function* (
  mover: SqlMover,
  exec: SqlExec,
  input: {
    readonly plan: SqlPlan;
    readonly service: string;
    readonly family: SqlFamily;
    readonly creds: SqlCreds;
    readonly env: Environment;
    readonly secrets: () => SqlCredentialSecrets;
    readonly file: string;
    readonly expectedDigest?: string;
  },
) {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  const from = {
    _tag: "hostPath",
    path: AbsolutePath.make(input.file),
    trusted: true,
  } satisfies DataEndpoint;
  const digest = input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest };
  if (input.family === "mssql") {
    const prepare = mssqlPrepareBackupCommand(input.creds.database);
    yield* checkedSqlExecution(exec(input.service, prepare, input.env), {
      ...input,
      command: prepare,
      stdout: "discard",
    });
    const transfer = yield* mover.transfer({
      from,
      to: {
        _tag: "servicePath",
        app,
        service,
        path: PortablePath.make(mssqlBackupServicePath(input.creds.database)),
      },
      overwrite: true,
      ...digest,
    });
    const restore = mssqlRestoreCommand(input.creds.database, input.creds.port);
    yield* checkedSqlExecution(exec(input.service, restore, input.env), {
      ...input,
      command: restore,
      stdout: "discard",
    });
    return transfer;
  }
  return yield* mover.transfer({
    from,
    to: {
      _tag: "serviceCmd",
      app,
      service,
      command: loadCommand(input.family, input.creds),
      env: yield* resolveSqlEnvironment(input.env),
      secrets: input.secrets(),
    },
    overwrite: true,
    ...digest,
  });
});

export const runReset = Effect.fn("Sql.reset")(function* (
  exec: SqlExec,
  service: string,
  family: SqlFamily,
  creds: SqlCreds,
  env: Environment,
  secrets: () => SqlCredentialSecrets = () => ({ substring: [], wholeToken: [] }),
) {
  const usesMysqlRoot = (family === "mysql" || family === "mariadb") && creds.rootPassword !== undefined;
  const command = resetCommand(family, usesMysqlRoot ? { ...creds, user: "root" } : creds);
  const resetEnv = usesMysqlRoot ? { ...env, MYSQL_PWD: creds.rootPassword } : env;
  yield* checkedSqlExecution(exec(service, command, resetEnv), {
    service,
    command,
    env: resetEnv,
    secrets,
    stdout: "discard",
  });
});
