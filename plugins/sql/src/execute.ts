import { RedactionService } from "@lando/redaction/service";
import { DateTime, Effect, Stream, absurd, flow } from "effect";

// allow: SIZE_OK — This command dispatcher keeps confirmation, recovery, and result publication in one ordered action state machine; family policy, readiness, seeding, and compatibility are separate modules.

import { SqlRecoveryOperationError, SqlSeedSourceError, SqlServiceNotFoundError } from "@lando/sdk/errors";
import type { DataTransferResult, PrunePolicy, SnapshotId, SnapshotInfo } from "@lando/sdk/schema";
import { snapshotHandle } from "@lando/sdk/schema";

import { requireVolume, runExport, runImport, runReset } from "./actions.ts";
import type { SqlExec } from "./actions.ts";
import { checkedSqlExecution } from "./checked-execution.ts";
import { hostFile, parseCount, secretTokens, validateExportCompressionLevel } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { compressionFromExportPath } from "./compression.ts";
import { credsEnv, currentAppliedDatabaseConnection, resolveSqlCreds } from "./creds.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { SqlEnvironmentSession, protectSqlEnvironment } from "./environment.ts";
import { countCommand } from "./families.ts";
import { confirmOrFail, publishTree } from "./progress.ts";
import { waitForSqlDatabase } from "./readiness.ts";
import { runPhysicalOperation, withPhysicalVolumeLock } from "./recovery.ts";
import type { DbCommandStep } from "./schemas.ts";
import { resolveSeedSource } from "./seed-source.ts";
import { executeSeed } from "./seed.ts";
import { requireRestoreCompatibleSnapshot } from "./snapshot-compatibility.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { executeSqliteCommand } from "./sqlite-execute.ts";
import { resolveSqlTarget } from "./target.ts";
import { sqlPlanIdentity } from "./views.ts";
export type { DbAction, DbCommandInput, SqlCommandDeps } from "./command-types.ts";

export { dbCommandRedactionTokens, dbInputFromCommand } from "./command-input.ts";

const withSqlRedaction = flow(Effect.provide(RedactionService.layer), Effect.scoped);

export const executeDbCommand = Effect.fn("Sql.executeDbCommand")(function* (
  rawDeps: SqlCommandDeps,
  input: DbCommandInput,
) {
  yield* validateExportCompressionLevel(input);
  const rawSession = yield* rawDeps.environmentResolver.openSession();
  const redaction = yield* RedactionService;
  const resolved = resolveSqlTarget(rawDeps.plan, input.service);
  if (resolved._tag === "Failure") return yield* Effect.fail(resolved.failure);
  const target = resolved.success;
  if (target.kind === "file") return yield* executeSqliteCommand(rawDeps, input, target);
  const owner = sqlPlanIdentity(rawDeps.plan);
  const service = rawDeps.plan.services[target.name];
  if (service === undefined) {
    return yield* Effect.fail(
      new SqlServiceNotFoundError({
        message: `No SQL service named ${target.name}.`,
        service: target.name,
        available: [],
        remediation: "Add a mysql, mariadb, postgres, mongodb, mssql, or sqlite service.",
      }),
    );
  }
  const connection = yield* currentAppliedDatabaseConnection(service, {
    app: rawDeps.plan.id,
    providerId: rawDeps.providerId,
  });
  const creds = resolveSqlCreds(connection);
  const env = credsEnv(target.family, creds);
  const selectedCredentials =
    target.family === "mssql"
      ? [creds.rootPassword ?? creds.password]
      : [
          creds.password,
          ...((target.family === "mysql" || target.family === "mariadb") &&
          input.action === "reset" &&
          creds.rootPassword !== undefined
            ? [creds.rootPassword]
            : []),
        ];
  const protectedEnvironment = yield* protectSqlEnvironment(rawSession, selectedCredentials, env);
  const session = protectedEnvironment.session;
  const exec: SqlExec = (service, command, env) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* protectedEnvironment.register;
        const concrete = env === undefined ? undefined : yield* session.resolveEnvironment(env);
        return rawDeps.exec(service, command, concrete);
      }),
    );
  const deps = { ...rawDeps, exec };
  return yield* Effect.gen(function* () {
    const waitForDatabase = waitForSqlDatabase(deps.exec, {
      service: target.name,
      command: countCommand(target.family, creds),
      env,
    });
    const resumeDatabase = (serviceName: string, identity: Parameters<typeof deps.resume>[1]) =>
      deps
        .resume(serviceName, identity)
        .pipe(Effect.andThen(waitForDatabase), Effect.provideService(SqlEnvironmentSession, session));
    if (
      input.action === "seed" &&
      [input.file, input.snapshotId, input.fromApp, input.fromPath].filter((source) => source !== undefined)
        .length !== 1
    ) {
      return yield* Effect.fail(
        new SqlSeedSourceError({
          message: `Seed ${target.name} requires exactly one source.`,
          service: target.name,
          remediation: "Pass exactly one dump file, --snapshot <id>, --from-app <id>, or --from-path <dir>.",
        }),
      );
    }
    const seedSource =
      input.action === "seed" && (input.fromApp !== undefined || input.fromPath !== undefined)
        ? yield* resolveSeedSource(rawDeps, input, target)
        : undefined;
    const file = hostFile(deps.plan, { ...input, service: target.name });
    const action = input.action;
    let restoreSource: SnapshotInfo | undefined;
    const store = action === "export" ? undefined : yield* requireVolume(deps.plan, service, target.name);
    const dump =
      action === "import" || (action === "seed" && input.file !== undefined)
        ? yield* ensureReadableDump(file, deps.plan.root)
        : undefined;
    const expectedDigest = dump?.digest;
    const compression = dump?.compression ?? compressionFromExportPath(file);
    const steps: DbCommandStep[] = [
      {
        id: action,
        label: `${action} ${target.name}`,
        target: target.name,
        destructive: action === "import" || action === "reset" || action === "restore",
      },
    ];

    if (action === "import") {
      const command = countCommand(target.family, creds);
      const counted = yield* checkedSqlExecution(deps.exec(target.name, command, env), {
        service: target.name,
        command,
        env,
      });
      const count = parseCount(counted.stdout);
      yield* confirmOrFail(
        input,
        deps.confirm,
        target.name,
        steps,
        count === undefined || count > 0
          ? `Import will replace data in ${target.name}.`
          : `Import will initialize ${target.name}.`,
      );
    }
    if (action === "reset") {
      yield* confirmOrFail(
        input,
        deps.confirm,
        target.name,
        steps,
        `Reset will destroy data in ${target.name}.`,
      );
    }
    if (action === "restore") {
      yield* confirmOrFail(
        input,
        deps.confirm,
        target.name,
        steps,
        `Restore will replace data in ${target.name}.`,
      );
    }
    if (action === "restore" || (action === "seed" && input.snapshotId !== undefined)) {
      const scope = yield* resolveSnapshotSource({
        app: deps.plan.id,
        ...(store === undefined ? {} : { store: store.store }),
        ownerKey: owner.ownerKey,
        service: target.name,
        hostCwd: input.hostCwd ?? process.cwd(),
        canonicalizePath: deps.canonicalizeSourcePath,
      });
      restoreSource = yield* deps.resolveSnapshot(input.snapshotId ?? "", scope);
    }

    let prunePolicy: PrunePolicy | undefined;
    let pruneCandidates: ReadonlyArray<SnapshotInfo> | undefined;
    if (action === "prune") {
      const filter = yield* resolveSnapshotSource({
        app: deps.plan.id,
        ...(store === undefined ? {} : { store: store.store }),
        ownerKey: owner.ownerKey,
        ...(deps.plan.identity?.repoGroupKey === undefined
          ? {}
          : { repoGroupKey: deps.plan.identity.repoGroupKey }),
        service: target.name,
        ...(input.fromApp === undefined ? {} : { fromApp: input.fromApp }),
        ...(input.fromPath === undefined ? {} : { fromPath: input.fromPath }),
        hostCwd: input.hostCwd ?? process.cwd(),
        canonicalizePath: deps.canonicalizeSourcePath,
      });
      const keepLatest = input.keepLatest ?? DEFAULT_SNAPSHOT_KEEP_LATEST;
      const snapshots = yield* deps.listSnapshots(filter);
      prunePolicy = { filter, keepLatest };
      pruneCandidates = [...snapshots]
        .filter((snapshot) => snapshot.metadata?.recoveryReason === "manual")
        .sort(
          (left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
        )
        .slice(keepLatest);
      if (input.preview !== true) {
        yield* confirmOrFail(
          input,
          deps.confirm,
          target.name,
          steps,
          `Retention will delete ${pruneCandidates.length} snapshot(s) for ${target.name}.`,
        );
      }
    }

    const progress = yield* publishTree(deps.publish, `db:${action}`, steps);

    const io = {
      plan: deps.plan,
      service: target.name,
      family: target.family,
      creds,
      env,
      file,
      compression,
      ...(input.compressionLevel === undefined ? {} : { compressionLevel: input.compressionLevel }),
      ...(expectedDigest === undefined ? {} : { expectedDigest }),
    };
    let snapshotId: string | undefined;
    let listedSnapshots: ReadonlyArray<SnapshotInfo> | undefined;
    let prunedSnapshotIds: ReadonlyArray<SnapshotId> | undefined;
    let retentionApplied: boolean | undefined;
    let transfer: DataTransferResult | undefined;
    let seedStatus: "seeded" | undefined;
    let completionReceipt:
      | { readonly recoverySnapshotId: string; readonly operation: SqlRecoveryOperationError["operation"] }
      | undefined;
    const runPhysical = <A, E>(
      reason: Parameters<typeof runPhysicalOperation<A, E>>[0]["reason"],
      body: Parameters<typeof runPhysicalOperation<A, E>>[0]["body"],
      resumeAfterSnapshot: boolean,
      preflight?: Parameters<typeof runPhysicalOperation<A, E>>[0]["preflight"],
      retainSnapshotIds?: ReadonlyArray<string>,
    ) =>
      runPhysicalOperation({
        deps: { ...deps, resume: resumeDatabase },
        plan: deps.plan,
        service,
        serviceName: target.name,
        family: target.family,
        creds,
        env,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.compression === undefined
          ? {}
          : {
              format:
                input.compression === "gzip" ? "tar.gz" : input.compression === "zstd" ? "tar.zst" : "tar",
            }),
        reason,
        publish: deps.publish,
        resumeAfterSnapshot,
        ...(preflight === undefined ? {} : { preflight }),
        ...(retainSnapshotIds === undefined ? {} : { retainSnapshotIds }),
        body,
      }).pipe(
        Effect.map(({ result, recoverySnapshotId }) => {
          completionReceipt = { recoverySnapshotId, operation: reason === "manual" ? "snapshot" : reason };
          return result;
        }),
      );
    switch (action) {
      case "export":
        transfer = yield* runExport(deps, deps.exec, io);
        break;
      case "import":
        transfer = yield* runPhysical(
          "import",
          () => runImport(deps, deps.exec, io).pipe(Effect.provideService(SqlEnvironmentSession, session)),
          true,
        );
        break;
      case "reset":
        yield* runPhysical(
          "reset",
          () =>
            runReset(deps.exec, target.name, target.family, creds, env).pipe(
              Effect.provideService(SqlEnvironmentSession, session),
            ),
          true,
        );
        break;
      case "snapshot": {
        const handle = yield* runPhysical(
          "manual",
          (_context, recoveryId) => Effect.succeed({ id: recoveryId }),
          true,
        );
        snapshotId = handle.id;
        break;
      }
      case "snapshots": {
        const filter = yield* resolveSnapshotSource({
          app: deps.plan.id,
          ...(store === undefined ? {} : { store: store.store }),
          ownerKey: owner.ownerKey,
          ...(deps.plan.identity?.repoGroupKey === undefined
            ? {}
            : { repoGroupKey: deps.plan.identity.repoGroupKey }),
          service: target.name,
          ...(input.fromApp === undefined ? {} : { fromApp: input.fromApp }),
          ...(input.fromPath === undefined ? {} : { fromPath: input.fromPath }),
          hostCwd: input.hostCwd ?? process.cwd(),
          canonicalizePath: deps.canonicalizeSourcePath,
        });
        listedSnapshots = yield* deps.listSnapshots(filter);
        break;
      }
      case "prune": {
        if (input.preview === true) {
          prunedSnapshotIds = [];
          retentionApplied = false;
          break;
        }
        if (prunePolicy === undefined)
          return yield* Effect.die(new Error("retention policy was not resolved"));
        prunedSnapshotIds = yield* deps.pruneSnapshots(prunePolicy);
        retentionApplied = true;
        break;
      }
      case "restore": {
        if (restoreSource === undefined)
          return yield* Effect.die(new Error("Restore source was not resolved"));
        snapshotId = restoreSource.id;
        const handle = snapshotHandle(restoreSource);
        yield* runPhysical(
          "restore",
          (context) =>
            Effect.gen(function* () {
              yield* context.verifyVolume;
              yield* deps.restore(handle, context.volume);
              if (context.running) yield* context.resume;
            }),
          false,
          (context) => requireRestoreCompatibleSnapshot(restoreSource, context),
          // The snapshot just restored from may itself be an automatic recovery snapshot.
          [restoreSource.id],
        );
        break;
      }
      case "seed":
        transfer = yield* withPhysicalVolumeLock({
          deps,
          plan: deps.plan,
          service,
          serviceName: target.name,
          family: target.family,
          creds,
          env,
          body: (context) =>
            executeSeed({ ...deps, resume: resumeDatabase }, context, {
              ...io,
              store: context.volume,
              ...(restoreSource === undefined ? {} : { snapshot: restoreSource }),
              ...(seedSource === undefined ? {} : { source: seedSource }),
            }).pipe(
              Effect.provideService(SqlEnvironmentSession, session),
              Effect.provideService(RedactionService, redaction),
            ),
        });
        seedStatus = "seeded";
        break;
      default:
        return absurd<never>(action);
    }

    yield* progress.complete.pipe(
      Effect.mapError((cause) =>
        completionReceipt === undefined
          ? cause
          : new SqlRecoveryOperationError({
              message: `${completionReceipt.operation} COMPLETED for ${target.name}, but its completion notification failed. Snapshot ${completionReceipt.recoverySnapshotId} remains available.`,
              service: target.name,
              operation: completionReceipt.operation,
              recoverySnapshotId: completionReceipt.recoverySnapshotId,
              cause,
              remediation:
                "Do not repeat the completed database operation. Resolve the notification failure; use lando db:snapshots to inspect available snapshots. No automatic rollback was performed.",
            }),
      ),
    );
    return {
      service: target.name,
      family: target.family,
      steps,
      redactionTokens: [
        ...(action === "snapshots" || action === "prune"
          ? secretTokens(creds)
          : protectedEnvironment.tokens()),
        ...(seedSource?.redactionTokens ?? []),
      ],
      ...(action === "import" || action === "export" ? { file } : {}),
      ...(snapshotId === undefined ? {} : { snapshotId }),
      ...(listedSnapshots === undefined ? {} : { snapshots: listedSnapshots }),
      ...(pruneCandidates === undefined
        ? {}
        : { pruneCandidates: pruneCandidates.map((snapshot) => snapshot.id) }),
      ...(prunedSnapshotIds === undefined ? {} : { prunedSnapshotIds }),
      ...(retentionApplied === undefined ? {} : { retentionApplied }),
      ...(seedStatus === undefined ? {} : { seedStatus }),
      ...(transfer?.accelerated === undefined ? {} : { accelerated: transfer.accelerated }),
      ...(transfer?.sizeBytes === undefined ? {} : { sizeBytes: transfer.sizeBytes }),
    };
  }).pipe(Effect.provideService(SqlEnvironmentSession, session));
}, withSqlRedaction);
