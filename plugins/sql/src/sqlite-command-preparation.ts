import { SqlConfirmRequiredError, SqlRecoveryUnavailableError, SqlSeedSourceError } from "@lando/sdk/errors";
import { ServiceName, type SnapshotFilter, type SnapshotInfo } from "@lando/sdk/schema";
import { physicalVolumeLockKey } from "@lando/sdk/services";
import { Effect } from "effect";

import { hostFile, resolveDumpStdio } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { ensureDumpFile, prepareImportDump } from "./dump-file.ts";
import { ensureExportDestination } from "./export-destination.ts";
import { confirmOrFail, publishTree } from "./progress.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { sqliteManualPruneSelection } from "./sqlite-retention.ts";
import { sqliteSnapshotVolume } from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import { sqlPlanIdentity } from "./views.ts";

export const prepareSqliteCommand = Effect.fn("Sql.prepareSqliteCommand")(function* (
  deps: SqlCommandDeps,
  input: DbCommandInput,
  target: SqlFileTarget,
) {
  const service = deps.plan.services[target.name];
  if (service === undefined) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `No SQL service named ${target.name}.`,
        service: target.name,
        reason: "The applied plan does not include this SQLite service.",
        remediation: "Run `lando start` to apply the plan, then retry.",
      }),
    );
  }
  if (input.action === "seed") {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        message: `Seed is not supported for SQLite file target ${target.name}.`,
        service: target.name,
        sourceFamily: "sqlite",
        remediation: "Use db:import, db:restore, or db:reset against the SQLite file instead.",
      }),
    );
  }
  const sqlite = deps.sqlite;
  if (sqlite === undefined) {
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `SQLite helper runtime is unavailable for ${target.name}.`,
        service: target.name,
        reason: "The command runtime did not provide a pinned sqlite3 helper.",
        remediation: "Retry from `lando db:*` after the SQL plugin is fully composed.",
      }),
    );
  }
  const owner = sqlPlanIdentity(deps.plan);
  const store = sqliteSnapshotVolume(deps.plan, target.path);
  const file = hostFile(deps.plan, { ...input, service: target.name });
  const dumpStdio = yield* resolveDumpStdio(input);
  if (input.action === "import" && dumpStdio === undefined) yield* ensureDumpFile(file, deps.plan.root);
  if (input.action === "export" && dumpStdio === undefined) yield* ensureExportDestination(file);
  const steps = [
    {
      id: input.action,
      label: `${input.action} ${target.name}`,
      target: target.name,
      destructive: input.action === "import" || input.action === "reset" || input.action === "restore",
    },
  ];
  if (input.action === "import" && file === "-" && !input.yes) {
    return yield* Effect.fail(
      new SqlConfirmRequiredError({
        message: `Import from stdin into ${target.name} requires --yes.`,
        service: target.name,
        steps,
        remediation: "Pass --yes. Stdin carries the dump, so Lando cannot prompt for confirmation.",
      }),
    );
  }
  if (input.action === "import") {
    yield* confirmOrFail(
      input,
      deps.confirm,
      target.name,
      steps,
      `Import will replace SQLite data at ${target.path} on ${target.name}.`,
    );
  }
  if (input.action === "reset") {
    yield* confirmOrFail(
      input,
      deps.confirm,
      target.name,
      steps,
      `Reset will empty ${target.path} on ${target.name}. Recovery covers only this SQLite database; service, configuration, and other databases are preserved. No migrations or seeds will run.`,
    );
  }
  if (input.action === "restore") {
    yield* confirmOrFail(
      input,
      deps.confirm,
      target.name,
      steps,
      `Restore will replace SQLite data at ${target.path} on ${target.name}.`,
    );
  }

  let restoreSource: SnapshotInfo | undefined;
  if (input.action === "restore") {
    const scope = yield* resolveSnapshotSource({
      plan: deps.plan,
      appliedPlans: deps.appliedPlans,
      store: store.store,
      ownerKey: owner.ownerKey,
      service: target.name,
      hostCwd: input.hostCwd ?? process.cwd(),
      canonicalizePath: deps.canonicalizeSourcePath,
    });
    restoreSource = yield* deps.resolveSnapshot(input.snapshotId ?? "", scope);
  }

  let pruneFilter: SnapshotFilter | undefined;
  let pruneCandidates: ReadonlyArray<SnapshotInfo> | undefined;
  if (input.action === "prune") {
    const sourceFilter = yield* resolveSnapshotSource({
      plan: deps.plan,
      appliedPlans: deps.appliedPlans,
      store: store.store,
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
    const filter = { ...sourceFilter, service: ServiceName.make(target.name) };
    const keepLatest = input.keepLatest ?? DEFAULT_SNAPSHOT_KEEP_LATEST;
    const snapshots = yield* deps.listSnapshots(filter);
    pruneFilter = filter;
    pruneCandidates = sqliteManualPruneSelection(snapshots, keepLatest).candidates;
    if (input.preview !== true && sqlite.removeSnapshot === undefined)
      return yield* Effect.fail(
        new SqlRecoveryUnavailableError({
          message: "SQLite snapshot removal is unavailable.",
          service: target.name,
          reason: "The snapshot catalog runtime did not provide exact snapshot removal.",
          remediation:
            "Use the standard database command runtime to remove the confirmed snapshot IDs safely.",
        }),
      );
    if (input.preview !== true) {
      yield* confirmOrFail(
        input,
        deps.confirm,
        target.name,
        steps,
        `Retention will delete ${pruneCandidates.length} manual SQLite snapshot(s) for ${target.name} from ${input.fromPath ?? input.fromApp ?? owner.appRoot}, keeping ${keepLatest} per service and path.`,
      );
    }
  }

  const progress = yield* publishTree(deps.publish, `db:${input.action}`, steps);
  const dump =
    input.action === "import"
      ? yield* prepareImportDump({
          file,
          appRoot: deps.plan.root,
          stagingDir: deps.stagingDir,
          privateFileAccess: deps.privateFileAccess,
          completeness: undefined,
          ...(dumpStdio?._tag === "stdin" ? { stdin: dumpStdio.stream } : {}),
        })
      : undefined;
  const lockKey = physicalVolumeLockKey(`sql-sqlite:${owner.ownerKey}:${store.store}`);
  return {
    action: input.action,
    service,
    sqlite,
    owner,
    store,
    file,
    dumpStdio,
    steps,
    restoreSource,
    pruneFilter,
    pruneCandidates,
    progress,
    dump,
    lockKey,
  };
});
