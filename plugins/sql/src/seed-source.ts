import { resolve } from "node:path";
import { Effect, absurd } from "effect";

import { SqlSeedSourceError, SqlServiceAmbiguousError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";

import { secretTokens } from "./command-input.ts";
import type { DbCommandInput, SqlCommandDeps } from "./command-types.ts";
import { credsEnv, resolveSqlCreds } from "./creds.ts";
import { dumpCommand } from "./families.ts";
import { type SqlTarget, resolveSqlTarget, sqlCandidates } from "./target.ts";
import { toSqlPlan } from "./views.ts";

export const resolveSeedSource = Effect.fn("Sql.resolveSeedSource")(function* (
  deps: SqlCommandDeps,
  input: DbCommandInput,
  target: SqlTarget,
) {
  const remediation = "Run `lando start` in the source checkout, then retry with --from-path <dir>.";
  const root =
    input.fromPath === undefined
      ? undefined
      : yield* deps.canonicalizeSourcePath(resolve(input.hostCwd ?? process.cwd(), input.fromPath));
  if (deps.appliedPlans === undefined) {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        message: `Provider ${deps.providerId} cannot list applied apps for database seeding.`,
        service: target.name,
        ...(input.fromApp === undefined ? {} : { sourceApp: input.fromApp }),
        ...(root === undefined ? {} : { sourceRoot: root }),
        remediation:
          "Run `lando db:export` in the source checkout, then `lando db:seed <file>` in this checkout.",
      }),
    );
  }
  const plans = yield* deps.appliedPlans;
  const source = plans.find((plan) => (root === undefined ? plan.id === input.fromApp : plan.root === root));
  if (source === undefined) {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        message: `No applied source app matches ${input.fromApp ?? root}.`,
        service: target.name,
        ...(input.fromApp === undefined ? {} : { sourceApp: input.fromApp }),
        ...(root === undefined ? {} : { sourceRoot: root }),
        remediation,
      }),
    );
  }
  const plan = toSqlPlan(source);
  const sameName = sqlCandidates(plan).some((candidate) => candidate.name === target.name);
  const resolved = resolveSqlTarget(plan, input.fromService ?? (sameName ? target.name : undefined));
  if (resolved._tag === "Failure") {
    const error = resolved.failure;
    switch (error._tag) {
      case "SqlServiceAmbiguousError":
        return yield* Effect.fail(
          new SqlServiceAmbiguousError({
            message: error.message,
            available: error.available,
            remediation: "Pass --from-service <name>.",
          }),
        );
      case "SqlServiceNotFoundError":
        return yield* Effect.fail(error);
      default:
        return absurd<never>(error);
    }
  }
  const service = resolved.success;
  const details = {
    service: target.name,
    sourceApp: source.id,
    sourceRoot: source.root,
    sourceService: service.name,
    sourceFamily: service.family,
    targetFamily: target.family,
  };
  if (service.family !== target.family) {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        ...details,
        message: `${service.family} cannot seed ${target.family}.`,
        remediation:
          "Use a source database of the same family, or convert a logical export before db:seed <file>.",
      }),
    );
  }
  if (service.family === "mssql") {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        ...details,
        message: "mssql does not support streaming database seeding.",
        remediation:
          "Use `lando db:export` in the source checkout, then `lando db:seed <file>` in the target checkout.",
      }),
    );
  }
  const info = yield* deps.inspectSource({
    app: source.id,
    service: ServiceName.make(service.name),
    plan: source,
  });
  if (info.status !== "running") {
    return yield* Effect.fail(
      new SqlSeedSourceError({
        ...details,
        message: `Source database ${service.name} in ${source.root} is not running.`,
        remediation: `Run \`lando start\` in ${source.root}, then retry with --from-path ${source.root}.`,
      }),
    );
  }
  const creds = resolveSqlCreds({
    family: service.family,
    serviceName: service.name,
    appName: plan.name,
    planEnvironment: plan.services[service.name]?.environment ?? {},
  });
  return {
    endpoint: {
      _tag: "serviceCmd" as const,
      app: source.id,
      service: ServiceName.make(service.name),
      command: dumpCommand(service.family, creds),
      env: credsEnv(service.family, creds),
    },
    database: creds.database,
    redactionTokens: secretTokens(creds),
  };
});
