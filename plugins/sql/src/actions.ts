import { Effect, type Scope, Stream } from "effect";

import { CommandStdioError, type VolumeNotFoundError } from "@lando/sdk/errors";
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
import { checkedSqlExecution } from "./checked-execution.ts";

import type { DumpCompression } from "./compression.ts";
import { withHostDumpCompression } from "./compression.ts";
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
    Effect.map((mount) => ({ app: AppId.make(plan.id), store: mount.store })),
  );

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
    readonly file: string;
    readonly compression: DumpCompression;
    readonly compressionLevel?: number;
    readonly stdout?: (chunk: Uint8Array) => Effect.Effect<void>;
  },
) {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  if (input.file === "-") {
    const write = input.stdout;
    if (write === undefined) {
      return yield* Effect.fail(
        new CommandStdioError({
          message: "db:export requested stdout for -, but no stdout stream was granted.",
          command: "db:export",
          stream: "stdout",
          reason: "unavailable",
          remediation: "Run this command from the terminal CLI, or pass a file path instead of -.",
        }),
      );
    }
    const from: DataEndpoint = yield* Effect.gen(function* () {
      if (input.family === "mssql") {
        const bak = mssqlBackupServicePath(input.creds.database);
        const backup = mssqlBackupCommand(input.creds.database, input.creds.port);
        const prepare = mssqlPrepareBackupCommand(input.creds.database);
        yield* checkedSqlExecution(exec(input.service, prepare, input.env), {
          ...input,
          command: prepare,
          stdout: "discard",
        });
        yield* checkedSqlExecution(exec(input.service, backup, input.env), {
          ...input,
          command: backup,
          stdout: "discard",
        });
        return {
          _tag: "servicePath" as const,
          app,
          service,
          path: PortablePath.make(bak),
        };
      }
      const env = yield* resolveSqlEnvironment(input.env);
      const secrets = input.secrets();
      return {
        _tag: "serviceCmd" as const,
        app,
        service,
        command: dumpCommand(input.family, input.creds),
        env,
        secrets,
      };
    });
    let sizeBytes = 0;
    yield* Stream.runForEach(mover.read(from), (chunk) =>
      Effect.gen(function* () {
        sizeBytes += chunk.byteLength;
        yield* write(chunk);
      }),
    );
    return { accelerated: false, sizeBytes } satisfies DataTransferResult;
  }
  return yield* withHostDumpCompression({
    path: input.file,
    compression: input.compression,
    ...(input.compressionLevel === undefined ? {} : { compressionLevel: input.compressionLevel }),
    direction: "export",
    transfer: Effect.fn("Sql.export.transfer")(function* (workingPath: string) {
      const path = AbsolutePath.make(workingPath);
      if (input.family === "mssql") {
        const bak = mssqlBackupServicePath(input.creds.database);
        const backup = mssqlBackupCommand(input.creds.database, input.creds.port);
        return yield* Effect.gen(function* () {
          const prepare = mssqlPrepareBackupCommand(input.creds.database);
          yield* checkedSqlExecution(exec(input.service, prepare, input.env), {
            ...input,
            command: prepare,
            stdout: "discard",
          });
          yield* checkedSqlExecution(exec(input.service, backup, input.env), {
            ...input,
            command: backup,
            stdout: "discard",
          });
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
      const env = yield* resolveSqlEnvironment(input.env);
      const secrets = input.secrets();
      return yield* mover.transfer({
        from: {
          _tag: "serviceCmd",
          app,
          service,
          command: dumpCommand(input.family, input.creds),
          env,
          secrets,
        },
        to: { _tag: "hostPath", path },
        overwrite: true,
      });
    }),
  });
});

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
    readonly compression: DumpCompression;
    readonly expectedDigest?: string;
  },
) {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  return yield* withHostDumpCompression({
    path: input.file,
    compression: input.compression,
    direction: "import",
    ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
    transfer: Effect.fn("Sql.import.transfer")(function* (workingPath: string, stagedDigest?: string) {
      // DataMover checks the file at workingPath. Uncompressed imports keep the
      // original dump digest from ensureReadableDump; compressed imports pass
      // the staged uncompressed digest from the helper.
      const digest = stagedDigest ?? input.expectedDigest;
      const path = AbsolutePath.make(workingPath);
      if (input.family === "mssql") {
        const bak = mssqlBackupServicePath(input.creds.database);
        return yield* Effect.gen(function* () {
          const prepare = mssqlPrepareBackupCommand(input.creds.database);
          yield* checkedSqlExecution(exec(input.service, prepare, input.env), {
            ...input,
            command: prepare,
            stdout: "discard",
          });
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
          const restore = mssqlRestoreCommand(input.creds.database, input.creds.port);
          yield* checkedSqlExecution(exec(input.service, restore, input.env), {
            ...input,
            command: restore,
            stdout: "discard",
          });
          return transfer;
        });
      }
      const env = yield* resolveSqlEnvironment(input.env);
      const secrets = input.secrets();
      return yield* mover.transfer({
        from: { _tag: "hostPath", path, trusted: true },
        to: {
          _tag: "serviceCmd",
          app,
          service,
          command: loadCommand(input.family, input.creds),
          env,
          secrets,
        },
        overwrite: true,
        ...(digest === undefined ? {} : { expectedDigest: digest }),
      });
    }),
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
