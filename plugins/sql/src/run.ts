import { isAbsolute, join, relative, resolve } from "node:path";

import { Effect } from "effect";

import { SqlServiceNotFoundError } from "@lando/sdk/errors";
import type { ExecutableCommandInput } from "@lando/sdk/plugins";
import { AppId, type DataTransferResult, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  DataMover,
  EventService,
  InteractionService,
  LandofileService,
  RuntimeProvider,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import {
  type SqlExec,
  type SqlMover,
  runExport,
  runImport,
  runReset,
  runRestore,
  runSnapshot,
} from "./actions.ts";
import { credsEnv, resolveSqlCreds } from "./creds.ts";
import { ensureReadableDump } from "./dump-file.ts";
import { countCommand } from "./families.ts";
import { isGzipPath } from "./gzip.ts";
import { type SqlPublisher, confirmOrFail, publishTree } from "./progress.ts";
import type { DbCommandStep } from "./schemas.ts";
import { resolveSqlTarget } from "./target.ts";
import { type SqlLandofile, type SqlPlan, sqlPlanFromLandofile, toSqlLandofile, toSqlPlan } from "./views.ts";

export type DbAction = "import" | "export" | "snapshot" | "restore" | "reset";

export type DbCommandInput = {
  readonly action: DbAction;
  readonly yes: boolean;
  readonly service?: string;
  readonly file?: string;
  readonly snapshotId?: string;
  readonly label?: string;
  readonly hostCwd?: string;
};

export type SqlCommandDeps = SqlMover & {
  readonly landofile: SqlLandofile;
  readonly plan: SqlPlan;
  readonly exec: SqlExec;
  readonly start: (service: string) => Effect.Effect<void, unknown>;
  readonly stop: (service: string) => Effect.Effect<void, unknown>;
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
    const file = hostFile(deps.plan, target.name, input.file, input.hostCwd ?? process.cwd());
    const action = input.action;
    if (action === "import") {
      yield* ensureReadableDump(file, deps.plan.root);
    }
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
      if (count === undefined || count > 0) {
        yield* confirmOrFail(
          input,
          deps.confirm,
          target.name,
          steps,
          `Import will replace data in ${target.name}.`,
        );
      }
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

    const progress = yield* publishTree(deps.publish, `db:${action}`, steps);

    const io = { plan: deps.plan, service: target.name, family: target.family, creds, env, file, gzip };
    let snapshotId: string | undefined;
    let transfer: DataTransferResult | undefined;
    switch (action) {
      case "export":
        transfer = yield* runExport(deps, deps.exec, io);
        break;
      case "import":
        transfer = yield* runImport(deps, deps.exec, io);
        break;
      case "reset":
        yield* runReset(deps.exec, target.name, target.family, creds, env);
        break;
      case "snapshot": {
        const handle = yield* runSnapshot(deps, deps.plan, service, target.name, input.label);
        snapshotId = handle.id;
        break;
      }
      case "restore":
        snapshotId = input.snapshotId ?? "";
        yield* runRestore(deps, deps.plan, service, target.name, snapshotId, deps.start, deps.stop);
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
  ...(typeof input.args.snapshot === "string" ? { snapshotId: input.args.snapshot } : {}),
  ...(typeof input.flags.label === "string" ? { label: input.flags.label } : {}),
});

export const runDbCommand = (input: DbCommandInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const landofiles = yield* LandofileService;
      const planner = yield* AppPlanner;
      const registry = yield* RuntimeProviderRegistry;
      const mover = yield* DataMover;
      const interaction = yield* InteractionService;
      const events = yield* EventService;
      const landofile = yield* landofiles.discover;
      const authored = toSqlLandofile(landofile);
      const prePlan = sqlPlanFromLandofile(authored);
      const earlyTarget = resolveSqlTarget(prePlan, input.service);
      if (earlyTarget._tag === "Left") return yield* Effect.fail(earlyTarget.left);
      const capabilities = yield* registry.capabilities;
      const planned = yield* planner.plan(landofile, capabilities);
      const provider = yield* registry.select(planned);
      const plan = toSqlPlan(planned);
      return yield* executeDbCommand(
        {
          landofile: authored,
          plan,
          transfer: (spec) => Effect.scoped(mover.transfer(spec)),
          snapshot: (store, opts) => Effect.scoped(mover.snapshot(store, opts)),
          restore: (id, store) => Effect.scoped(mover.restore(id, store)),
          exec: (service, command, env) =>
            provider
              .exec(
                { app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned },
                { command, ...(env === undefined ? {} : { env }) },
              )
              .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout }))),
          start: (service) =>
            provider.start({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned }),
          stop: (service) =>
            provider.stop({ app: AppId.make(plan.id), service: ServiceName.make(service), plan: planned }),
          confirm: (message) => Effect.scoped(interaction.confirm({ message, default: false })),
          publish: (event) => events.publish(event),
        },
        input,
      ).pipe(Effect.provideService(RuntimeProvider, provider));
    }),
  );
