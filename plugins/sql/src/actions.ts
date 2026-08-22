import { Effect } from "effect";

import { SqlCommandFailedError, VolumeNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type DataTransferResult,
  type DataTransferSpec,
  PortablePath,
  ServiceName,
  type SnapshotHandle,
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
  mssqlRestoreCommand,
  resetCommand,
} from "./families.ts";
import { wrapExportCommand, wrapImportCommand } from "./gzip.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";

export type SqlExec = (
  service: string,
  command: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) => Effect.Effect<{ readonly ok: boolean; readonly stdout: string }, unknown>;

export type SqlMover = {
  readonly transfer: (spec: DataTransferSpec) => Effect.Effect<DataTransferResult, unknown>;
  readonly snapshot: (store: VolumeRef, opts?: SnapshotOptions) => Effect.Effect<SnapshotHandle, unknown>;
  readonly restore: (id: string, store: VolumeRef) => Effect.Effect<void, unknown>;
};

const requireVolume = (
  plan: SqlPlan,
  service: SqlPlanService,
  name: string,
): Effect.Effect<VolumeRef, VolumeNotFoundError> => {
  const store = service.storage[0]?.store;
  if (store === undefined) {
    return Effect.fail(
      new VolumeNotFoundError({
        message: `Service ${name} has no data volume.`,
        store: name,
        app: plan.id,
        remediation: "Add persistent storage to the database service.",
      }),
    );
  }
  return Effect.succeed({ app: AppId.make(plan.id), store });
};

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
  },
) => {
  const app = AppId.make(input.plan.id);
  const service = ServiceName.make(input.service);
  const path = AbsolutePath.make(input.file);
  if (input.family === "mssql") {
    const bak = mssqlBackupServicePath(input.creds.database);
    return Effect.gen(function* () {
      yield* mover.transfer({
        from: { _tag: "hostPath", path },
        to: {
          _tag: "servicePath",
          app,
          service,
          path: PortablePath.make(input.gzip ? `${bak}.gz` : bak),
        },
        overwrite: true,
      });
      if (input.gzip) {
        const gunzip = ["gunzip", "-f", `${bak}.gz`] as const;
        yield* requireExecOk(yield* exec(input.service, gunzip, input.env), input.service, gunzip);
      }
      const restore = mssqlRestoreCommand(input.creds.database);
      yield* requireExecOk(yield* exec(input.service, restore, input.env), input.service, restore);
      return { accelerated: true };
    });
  }
  return mover.transfer({
    from: { _tag: "hostPath", path },
    to: {
      _tag: "serviceCmd",
      app,
      service,
      command: wrapImportCommand(loadCommand(input.family, input.creds), input.gzip),
      env: input.env,
    },
    overwrite: true,
  });
};

export const runReset = (
  exec: SqlExec,
  service: string,
  family: SqlFamily,
  creds: SqlCreds,
  env: Readonly<Record<string, string>>,
) => {
  const command = resetCommand(family, creds);
  return exec(service, command, env).pipe(
    Effect.flatMap((result) => requireExecOk(result, service, command)),
  );
};

export const runSnapshot = (
  mover: SqlMover,
  plan: SqlPlan,
  service: SqlPlanService,
  name: string,
  label?: string,
) =>
  Effect.gen(function* () {
    const store = yield* requireVolume(plan, service, name);
    return yield* mover.snapshot(store, { format: "tar.gz", ...(label === undefined ? {} : { label }) });
  });

export const runRestore = (
  mover: SqlMover,
  plan: SqlPlan,
  service: SqlPlanService,
  name: string,
  snapshotId: string,
  start: (service: string) => Effect.Effect<void, unknown>,
  stop: (service: string) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const store = yield* requireVolume(plan, service, name);
    yield* stop(name);
    const restored = yield* mover.restore(snapshotId, store).pipe(Effect.exit);
    const started = yield* start(name).pipe(Effect.either);
    if (restored._tag === "Failure") return yield* Effect.failCause(restored.cause);
    if (started._tag === "Left") return yield* Effect.fail(started.left);
  });
