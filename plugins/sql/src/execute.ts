import { DateTime, Effect } from "effect";

// allow: SIZE_OK — This command dispatcher keeps confirmation, recovery, and result publication in one ordered action state machine; family policy, readiness, seeding, and compatibility are separate modules.

import { SqlRecoveryUnavailableError, SqlSeedSourceError, SqlServiceNotFoundError } from "@lando/sdk/errors";
import type { DataTransferResult, PrunePolicy, SnapshotId, SnapshotInfo } from "@lando/sdk/schema";

import { requireVolume, runExport, runImport, runReset } from "./actions.ts";
import { hostFile, parseCount, secretTokens } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { compressionFromExportPath } from "./compression.ts";
import { credsEnv, resolveSqlCreds } from "./creds.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { countCommand } from "./families.ts";
import { confirmOrFail, publishTree } from "./progress.ts";
import { waitForSqlDatabase } from "./readiness.ts";
import { runPhysicalOperation, withPhysicalVolumeLock } from "./recovery.ts";
import type { DbCommandStep } from "./schemas.ts";
import { executeSeed } from "./seed.ts";
import { requireCompatibleSnapshot } from "./snapshot-compatibility.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { resolveSqlTarget } from "./target.ts";
export type { DbAction, DbCommandInput, SqlCommandDeps } from "./command-types.ts";

const assertNever = (value: never): never => {
  throw new Error(`unexpected db action: ${String(value)}`);
};

export { dbCommandRedactionTokens, dbInputFromCommand } from "./command-input.ts";

export const executeDbCommand = (deps: SqlCommandDeps, input: DbCommandInput) =>
  Effect.gen(function* () {
    const resolved = resolveSqlTarget(deps.plan, input.service);
    if (resolved._tag === "Left") return yield* Effect.fail(resolved.left);
    const target = resolved.right;
    const service = deps.plan.services[target.name];
    if (service === undefined) {
      return yield* Effect.fail(
        new SqlServiceNotFoundError({
          message: `No SQL service named ${target.name}.`,
          service: target.name,
          available: [],
          remediation: "Add a mysql, mariadb, postgres, mongodb, or mssql service.",
        }),
      );
    }
    const authored = deps.landofile.services?.[target.name];
    const creds = resolveSqlCreds({
      family: target.family,
      serviceName: target.name,
      appName: deps.plan.name,
      ...(authored === undefined ? {} : { landofileService: authored }),
      planEnvironment: service.environment,
    });
    const tokens = secretTokens(creds);
    const env = credsEnv(target.family, creds);
    const waitForDatabase = waitForSqlDatabase(deps.exec, {
      service: target.name,
      command: countCommand(target.family, creds),
      env,
    });
    const resumeDatabase = (serviceName: string, identity: Parameters<typeof deps.resume>[1]) =>
      deps.resume(serviceName, identity).pipe(Effect.zipRight(waitForDatabase));
    if (input.action === "seed" && (input.file === undefined) === (input.snapshotId === undefined)) {
      return yield* Effect.fail(
        new SqlSeedSourceError({
          message: `Seed ${target.name} requires exactly one source.`,
          service: target.name,
          remediation: "Pass one dump file or --snapshot <id>.",
        }),
      );
    }
    const file = hostFile(deps.plan, { ...input, service: target.name });
    const action = input.action;
    let restoreSource: SnapshotInfo | undefined;
    const store = action === "export" ? undefined : yield* requireVolume(deps.plan, service, target.name);
    const dump =
      action === "import" || (action === "seed" && input.snapshotId === undefined)
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
      const counted = yield* deps
        .exec(target.name, countCommand(target.family, creds), env)
        .pipe(Effect.catchAll(() => Effect.succeed({ ok: false, stdout: "" })));
      const count = counted.ok ? parseCount(counted.stdout) : undefined;
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
      const sourceId = input.snapshotId ?? "";
      const candidates = yield* deps.listSnapshots({ id: sourceId });
      const source = candidates.find((candidate) => candidate.id === sourceId);
      if (source === undefined) {
        return yield* Effect.fail(
          new SqlRecoveryUnavailableError({
            message: `Snapshot ${sourceId} is not physically compatible with ${target.name}.`,
            service: target.name,
            reason: "Snapshot metadata is unavailable.",
            remediation: "Use a matching physical snapshot or move data with logical export and import.",
          }),
        );
      }
      restoreSource = source;
    }

    let prunePolicy: PrunePolicy | undefined;
    let pruneCandidates: ReadonlyArray<SnapshotInfo> | undefined;
    if (action === "prune") {
      const filter = yield* resolveSnapshotSource({
        app: deps.plan.id,
        ...(store === undefined ? {} : { store: store.store }),
        ...(deps.plan.identity?.ownerKey === undefined ? {} : { ownerKey: deps.plan.identity.ownerKey }),
        ...(deps.plan.identity?.repoGroupKey === undefined
          ? {}
          : { repoGroupKey: deps.plan.identity.repoGroupKey }),
        service: target.name,
        ...(input.fromApp === undefined ? {} : { fromApp: input.fromApp }),
        ...(input.fromPath === undefined ? {} : { fromPath: input.fromPath }),
        hostCwd: input.hostCwd ?? process.cwd(),
        canonicalizePath: deps.canonicalizeSourcePath,
      });
      const keepLatest = input.keepLatest ?? 3;
      const snapshots = yield* deps.listSnapshots(filter);
      prunePolicy = { filter, keepLatest };
      pruneCandidates = [...snapshots]
        .filter((snapshot) => snapshot.metadata?.recoveryReason === "manual")
        .sort(
          (left, right) =>
            Date.parse(DateTime.formatIso(right.createdAt)) - Date.parse(DateTime.formatIso(left.createdAt)),
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
      ...(expectedDigest === undefined ? {} : { expectedDigest }),
    };
    let snapshotId: string | undefined;
    let listedSnapshots: ReadonlyArray<SnapshotInfo> | undefined;
    let prunedSnapshotIds: ReadonlyArray<SnapshotId> | undefined;
    let retentionApplied: boolean | undefined;
    let transfer: DataTransferResult | undefined;
    let seedStatus: "seeded" | undefined;
    const runPhysical = <A, E>(
      reason: Parameters<typeof runPhysicalOperation<A, E>>[0]["reason"],
      body: Parameters<typeof runPhysicalOperation<A, E>>[0]["body"],
      resumeAfterSnapshot: boolean,
      preflight?: Parameters<typeof runPhysicalOperation<A, E>>[0]["preflight"],
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
        resumeAfterSnapshot,
        ...(preflight === undefined ? {} : { preflight }),
        body,
      });
    switch (action) {
      case "export":
        transfer = yield* runExport(deps, deps.exec, io);
        break;
      case "import":
        transfer = yield* runPhysical("import", () => runImport(deps, deps.exec, io), true);
        break;
      case "reset":
        yield* runPhysical("reset", () => runReset(deps.exec, target.name, target.family, creds, env), true);
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
          ...(deps.plan.identity?.ownerKey === undefined ? {} : { ownerKey: deps.plan.identity.ownerKey }),
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
        if (prunePolicy === undefined) return yield* Effect.dieMessage("retention policy was not resolved");
        prunedSnapshotIds = yield* deps.pruneSnapshots(prunePolicy);
        retentionApplied = true;
        break;
      }
      case "restore":
        snapshotId = input.snapshotId ?? "";
        {
          yield* runPhysical(
            "restore",
            (context) =>
              Effect.gen(function* () {
                yield* context.verifyVolume;
                yield* deps.restore(snapshotId ?? "", context.volume);
                if (context.running) yield* context.resume;
              }),
            false,
            (context) => requireCompatibleSnapshot(restoreSource, context),
          );
        }
        break;
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
              ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
            }),
        });
        seedStatus = "seeded";
        break;
      default:
        return assertNever(action);
    }

    yield* progress.complete;
    return {
      service: target.name,
      family: target.family,
      steps,
      redactionTokens: tokens,
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
  });
