import { isAbsolute, join, relative, resolve } from "node:path";

import { Effect } from "effect";

import {
  SqlRecoveryUnavailableError,
  SqlSeedSourceError,
  SqlSeedStateError,
  SqlServiceNotFoundError,
} from "@lando/sdk/errors";
import type { ExecutableCommandInput } from "@lando/sdk/plugins";
import { type AbsolutePath, AppId, type DataTransferResult, type SnapshotInfo } from "@lando/sdk/schema";

import { type SqlExec, type SqlMover, requireVolume, runExport, runImport, runReset } from "./actions.ts";
import { credsEnv, resolveSqlCreds } from "./creds.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { countCommand } from "./families.ts";
import { isGzipPath } from "./gzip.ts";
import { type SqlPublisher, confirmOrFail, publishTree } from "./progress.ts";
import { type SqlRecoveryDeps, runPhysicalOperation, withPhysicalVolumeLock } from "./recovery.ts";
import type { DbCommandStep } from "./schemas.ts";
import { resolveSnapshotSource } from "./snapshot-source.ts";
import { resolveSqlTarget } from "./target.ts";
import type { SqlLandofile, SqlPlan } from "./views.ts";

export type DbAction = "import" | "export" | "snapshot" | "snapshots" | "restore" | "reset" | "seed";

export type DbCommandInput = {
  readonly action: DbAction;
  readonly yes: boolean;
  readonly service?: string;
  readonly file?: string;
  readonly snapshotId?: string;
  readonly label?: string;
  readonly compression?: "gzip" | "zstd" | "none";
  readonly fromApp?: string;
  readonly fromPath?: string;
  readonly hostCwd?: string;
};

export type SqlCommandDeps = SqlMover &
  SqlRecoveryDeps & {
    readonly landofile: SqlLandofile;
    readonly plan: SqlPlan;
    readonly exec: SqlExec;
    readonly canonicalizeSourcePath: (
      path: string,
    ) => Effect.Effect<AbsolutePath, SqlRecoveryUnavailableError>;
    readonly confirm: (message: string) => Effect.Effect<boolean, unknown>;
    readonly publish: SqlPublisher;
  };

const assertNever = (value: never): never => {
  throw new Error(`unexpected db action: ${String(value)}`);
};

const isInsideAppRoot = (hostCwd: string, appRoot: string): boolean => {
  const rel = relative(resolve(appRoot), resolve(hostCwd));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const hostFile = (
  plan: SqlPlan,
  service: string,
  file = `${service}.sql.gz`,
  hostCwd = process.cwd(),
): string => {
  if (isAbsolute(file)) return file;
  const base = isInsideAppRoot(hostCwd, plan.root) ? hostCwd : plan.root;
  return join(base, file);
};

const parseCount = (stdout: string): number | undefined => {
  const match = stdout.trim().match(/\d+/u);
  if (match === null) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
};

const requireCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  sourceId: string,
  context: { readonly metadata: NonNullable<SnapshotInfo["metadata"]> },
  service: string,
  appRoot: string,
) => {
  const metadata = source?.metadata;
  return metadata !== undefined &&
    metadata.family === context.metadata.family &&
    metadata.version === context.metadata.version &&
    metadata.imageIdentity === context.metadata.imageIdentity &&
    metadata.volumeInstanceId === context.metadata.volumeInstanceId &&
    metadata.sourceRoot === appRoot
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Snapshot ${sourceId} is not physically compatible with ${service}.`,
          service,
          reason: "Snapshot ownership, family, version, image, or physical volume identity does not match.",
          remediation: "Use a matching physical snapshot or move data with logical export and import.",
        }),
      );
};

const secretTokens = (creds: { readonly password?: string; readonly rootPassword?: string }): string[] =>
  [creds.password, creds.rootPassword].flatMap((token) =>
    token === undefined || token.length === 0 ? [] : [token],
  );

export const dbCommandRedactionTokens = (result: unknown): ReadonlyArray<string> => {
  if (typeof result !== "object" || result === null || !("redactionTokens" in result)) return [];
  const tokens = result.redactionTokens;
  return Array.isArray(tokens) ? tokens.filter((token): token is string => typeof token === "string") : [];
};

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
    if (input.action === "seed" && (input.file === undefined) === (input.snapshotId === undefined)) {
      return yield* Effect.fail(
        new SqlSeedSourceError({
          message: `Seed ${target.name} requires exactly one source.`,
          service: target.name,
          remediation: "Pass one dump file or --snapshot <id>.",
        }),
      );
    }
    const file = hostFile(deps.plan, target.name, input.file, input.hostCwd ?? process.cwd());
    const action = input.action;
    const store = action === "export" ? undefined : yield* requireVolume(deps.plan, service, target.name);
    const expectedDigest =
      action === "import" || (action === "seed" && input.snapshotId === undefined)
        ? yield* ensureReadableDump(file, deps.plan.root)
        : undefined;
    const gzip = isGzipPath(file);
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
    }

    const progress = yield* publishTree(deps.publish, `db:${action}`, steps);

    const io = {
      plan: deps.plan,
      service: target.name,
      family: target.family,
      creds,
      env,
      file,
      gzip,
      ...(expectedDigest === undefined ? {} : { expectedDigest }),
    };
    let snapshotId: string | undefined;
    let listedSnapshots: ReadonlyArray<SnapshotInfo> | undefined;
    let transfer: DataTransferResult | undefined;
    let seedStatus: "seeded" | undefined;
    const runPhysical = <A, E>(
      reason: Parameters<typeof runPhysicalOperation<A, E>>[0]["reason"],
      body: Parameters<typeof runPhysicalOperation<A, E>>[0]["body"],
      resumeAfterSnapshot: boolean,
      preflight?: Parameters<typeof runPhysicalOperation<A, E>>[0]["preflight"],
    ) =>
      runPhysicalOperation({
        deps,
        plan: deps.plan,
        service,
        serviceName: target.name,
        family: target.family,
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
      case "restore":
        snapshotId = input.snapshotId ?? "";
        {
          const source = (yield* deps.listSnapshots({ id: snapshotId })).find(
            (candidate) => candidate.id === snapshotId,
          );
          yield* runPhysical(
            "restore",
            (context) =>
              Effect.gen(function* () {
                yield* deps.restore(snapshotId ?? "", {
                  app: AppId.make(deps.plan.id),
                  store: store?.store ?? "",
                });
                if (context.running) yield* deps.start(target.name);
              }),
            false,
            (context) =>
              requireCompatibleSnapshot(source, snapshotId ?? "", context, target.name, deps.plan.root),
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
          body: (context) =>
            Effect.gen(function* () {
              const status = yield* deps.getSeedStatus(context.metadata.volumeInstanceId);
              const counted = yield* deps.exec(target.name, countCommand(target.family, creds), env);
              const count = counted.ok ? parseCount(counted.stdout) : undefined;
              if (status !== "fresh" || count !== 0) {
                return yield* Effect.fail(
                  new SqlSeedStateError({
                    message: `Cannot seed ${target.name} from state ${status}.`,
                    service: target.name,
                    status,
                    remediation:
                      "Create a fresh database volume or explicitly import into the existing database.",
                  }),
                );
              }
              yield* deps.setSeedStatus(context.metadata.volumeInstanceId, "in-progress");
              if (input.snapshotId !== undefined) {
                const source = (yield* deps.listSnapshots({ id: input.snapshotId })).find(
                  (candidate) => candidate.id === input.snapshotId,
                );
                yield* requireCompatibleSnapshot(
                  source,
                  input.snapshotId,
                  context,
                  target.name,
                  deps.plan.root,
                );
              }
              const seeded = (
                input.snapshotId === undefined
                  ? runImport(deps, deps.exec, io)
                  : deps
                      .restore(input.snapshotId, store ?? { app: AppId.make(deps.plan.id), store: "" })
                      .pipe(Effect.as(undefined))
              ).pipe(Effect.tapError(() => deps.setSeedStatus(context.metadata.volumeInstanceId, "failed")));
              const result = yield* seeded;
              yield* deps.setSeedStatus(context.metadata.volumeInstanceId, "seeded");
              return result;
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
      ...(seedStatus === undefined ? {} : { seedStatus }),
      ...(transfer?.accelerated === undefined ? {} : { accelerated: transfer.accelerated }),
      ...(transfer?.sizeBytes === undefined ? {} : { sizeBytes: transfer.sizeBytes }),
    };
  });

export const dbInputFromCommand = (action: DbAction, input: ExecutableCommandInput): DbCommandInput => ({
  action,
  yes: input.flags.yes === true,
  hostCwd: process.cwd(),
  ...(typeof input.flags.service === "string" ? { service: input.flags.service } : {}),
  ...(typeof input.args.file === "string" ? { file: input.args.file } : {}),
  ...(typeof input.args.snapshot === "string"
    ? { snapshotId: input.args.snapshot }
    : typeof input.flags.snapshot === "string"
      ? { snapshotId: input.flags.snapshot }
      : {}),
  ...(typeof input.flags.label === "string" ? { label: input.flags.label } : {}),
  ...(typeof input.flags["from-app"] === "string" ? { fromApp: input.flags["from-app"] } : {}),
  ...(typeof input.flags["from-path"] === "string" ? { fromPath: input.flags["from-path"] } : {}),
  ...(input.flags.compression === "gzip" ||
  input.flags.compression === "zstd" ||
  input.flags.compression === "none"
    ? { compression: input.flags.compression }
    : {}),
});
