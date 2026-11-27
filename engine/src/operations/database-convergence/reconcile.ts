import { classifyCredentialLiterals, planCredentialClassification } from "@lando/redaction/plan-values";
import { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { SqlCredentialApplyError } from "@lando/sdk/errors";
import type { AppPlan, DatabaseConnection, EnvironmentValue, ServicePlan } from "@lando/sdk/schema";
import {
  type DatabaseCredentialConvergenceRequest,
  type DatabaseCredentialConvergenceResult,
  type EnvironmentValueResolverSession,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { deriveDatabaseAdminPassword } from "@lando/state-store/database-admin-seed";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { withPhysicalVolumeLock } from "@lando/state-store/volume-lock";
import { Effect, Equal, Option, Redacted, Result } from "effect";
import { settleOrdinaryFailure } from "../../lifecycle/failure-compensation.ts";
import { chooseAdmin, validPassword } from "./admin.ts";
import { credentialClient } from "./client.ts";
import { containerAddress } from "./container-address.ts";
import { matchedBatch } from "./matched-probe.ts";
import { mongodb } from "./mongodb.ts";
import { mssql } from "./mssql.ts";
import { mysqlFamily } from "./mysql-family.ts";
import { postgres } from "./postgres.ts";
import { type ActivatedDatabaseTarget, observeTarget, targetError } from "./target.ts";
import type { AdapterContext, CredentialStep } from "./types.ts";

const adapters = { postgres, mysql: mysqlFamily, mariadb: mysqlFamily, mongodb, mssql };
const members = ["user", "password", "database", "rootPassword"] as const;
const changed = (delta: readonly CredentialStep[]) =>
  members.filter((member) => delta.some((step) => step.members.includes(member)));

export const prepareReconciliation = Effect.fn("DatabaseConvergence.prepare")(function* (input: {
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly provider: RuntimeProviderShape;
  readonly desired: DatabaseConnection;
  readonly previous?: DatabaseConnection;
  readonly session: EnvironmentValueResolverSession;
  readonly fallback?: Pick<DatabaseCredentialConvergenceRequest, "adminUser" | "readPassword">;
  readonly adminSeedRoot: string;
  readonly onAdminSeedUnavailable?: Effect.Effect<void>;
  readonly applying?: ActivatedDatabaseTarget;
  readonly retained?: readonly ServicePlan[];
  readonly onMutationDispatch?: Effect.Effect<void>;
}) {
  const {
    plan,
    service,
    provider,
    session,
    fallback,
    desired: { family, creds },
    previous,
  } = input;
  const old = previous?.creds ?? creds;
  const redaction = yield* RedactionService;
  const register = (value: string) =>
    redaction.registerValues([
      value,
      encodeURIComponent(value),
      value.replaceAll("'", "''"),
      JSON.stringify(value).slice(1, -1),
    ]);
  // Literal descriptors take the plan's redaction tier: a published default password such as
  // "lando" is not a secret, and a substring registration would mask every later "lando".
  const classification = planCredentialClassification(plan);
  const registerCredential = Effect.fnUntraced(function* (descriptor: EnvironmentValue, resolved: string) {
    if (typeof descriptor !== "string") return yield* register(resolved);
    const { substring, wholeToken } = classifyCredentialLiterals(classification, [descriptor]);
    for (const value of substring) yield* register(value);
    if (wholeToken.length > 0) yield* redaction.registerValues(wholeToken, { match: "whole-token" });
  });
  if (
    [creds.user, old.user].some((user) => user.toLowerCase() === "lando_admin") ||
    fallback?.adminUser?.toLowerCase() === "lando_admin"
  ) {
    return yield* targetError(
      "unsafe-name",
      "The database administrator name lando_admin is reserved.",
      service.name,
    );
  }
  if (!validPassword(creds.user, 255) || !validPassword(creds.database, 255)) {
    return yield* targetError(
      "unsafe-name",
      "The desired login or database name cannot be represented safely.",
      service.name,
    );
  }
  if (
    fallback?.adminUser !== undefined &&
    ((family !== "postgres" && family !== "mongodb") || !validPassword(fallback.adminUser, 63))
  ) {
    return yield* targetError(
      "unsafe-name",
      "An explicit administrator name is supported only for PostgreSQL and MongoDB.",
      service.name,
    );
  }
  const observed = yield* observeTarget(input);
  let phase: SqlCredentialApplyError["phase"] = "preflight";
  let possibleWrite = false;
  const completed = new Set<(typeof members)[number]>();
  const failure: AdapterContext["failure"] = (message, exitCode, kind) =>
    new SqlCredentialApplyError({
      service: service.name,
      family,
      phase,
      message,
      mutation: completed.size > 0 ? "partial" : possibleWrite ? "possible" : "none",
      ...(kind === "transient" && phase === "preflight" && !possibleWrite ? { retryable: true } : {}),
      completed: members.filter((member) => completed.has(member)),
      ...(exitCode === undefined ? {} : { exitCode }),
      remediation: possibleWrite
        ? "Preview the database state before retrying; do not reset the volume."
        : "Check database authentication and administrator privileges before retrying.",
    });
  const resolve = Effect.fnUntraced(function* (value: typeof creds.rootPassword, required: boolean) {
    if (value === undefined) return undefined;
    const result = yield* settleOrdinaryFailure(
      session
        .resolveEnvironment({ value })
        .pipe(mapFailures(() => failure("A database credential could not be resolved."))),
    );
    if (
      Result.isSuccess(result) &&
      result.success.value !== undefined &&
      validPassword(result.success.value)
    ) {
      yield* registerCredential(value, result.success.value);
      return result.success.value;
    }
    if (required) return yield* failure("A desired credential could not be resolved or represented safely.");
    return undefined;
  });
  const password = yield* resolve(creds.password, true);
  if (password === undefined) return yield* failure("The desired password is absent.");
  const rootPassword = yield* resolve(creds.rootPassword, true);
  const oldPassword = yield* resolve(old.password, false);
  const oldRoot = yield* resolve(old.rootPassword, false);
  const target = { app: plan.id, service: service.name, plan, expectedContainerId: observed.containerId };
  const run = credentialClient({ provider, target, family, failure });
  let managedPassword: string | undefined;
  if (family === "postgres") managedPassword = "";
  else {
    const access = yield* Effect.serviceOption(PrivateFileAccessService);
    const derived = Option.isNone(access)
      ? Option.none()
      : yield* settleOrdinaryFailure(
          deriveDatabaseAdminPassword({
            userDataRoot: input.adminSeedRoot,
            family,
            generation: observed.physical.generation,
            register: redaction.registerValues,
            ...(fallback === undefined ? {} : { mode: "read" as const }),
          }).pipe(
            Effect.provideService(PrivateFileAccessService, access.value),
            mapFailures(() => failure("The private database administrator seed could not be read.")),
          ),
        ).pipe(Effect.map(Result.getSuccess));
    if (Option.isSome(derived)) managedPassword = Redacted.value(derived.value);
    else yield* input.onAdminSeedUnavailable ?? Effect.void;
  }
  const managed =
    managedPassword === undefined ? undefined : { user: "lando_admin", password: managedPassword };
  if (managed !== undefined) {
    const probe = matchedBatch({
      family,
      port: input.desired.port,
      user: creds.user,
      database: creds.database,
      password,
      rootPassword,
      adminPassword: managed.password,
    });
    if (probe !== undefined) {
      const result = yield* run(probe);
      if (result.exitCode === 0 && result.stdout.trim() === "lando-matched") {
        const preview: DatabaseCredentialConvergenceResult = {
          service: service.name,
          family,
          outcome: "already-matched",
          changedMembers: [],
        };
        return { preview, apply: Effect.succeed(preview), volume: observed.physical };
      }
    }
  }
  const isMysqlFamily = family === "mysql" || family === "mariadb";
  if (family === "mongodb") {
    // The image's temporary initialization server listens only on loopback.
    // Keep the authenticated connection on loopback, but do not trust its catalog
    // until the final server is also listening on the container's own address.
    const listener = yield* run({
      argv: [
        "bash",
        "-ec",
        `${containerAddress}\naddress=$(container_address); test -n "$address"; timeout 2 bash -c ': >"/dev/tcp/$1/$2"' _ "$address" "$PORT"`,
      ],
      env: { PORT: String(input.desired.port) },
    });
    if (listener.exitCode !== 0) {
      return yield* failure("The final MongoDB listener is not ready.", listener.exitCode, "transient");
    }
  }
  let host: string | undefined;
  if (family === "postgres" || isMysqlFamily) {
    // Both entrypoints initialize through a socket-only server. Do not inspect its
    // partial catalog or adopt an admin until the final server is listening on TCP.
    const ping = isMysqlFamily
      ? `${family === "mysql" ? "mysqladmin" : "mariadb-admin"} --no-defaults --protocol=TCP -h 127.0.0.1 -P "$PORT" --connect-timeout=2 ping >/dev/null 2>&1\n`
      : 'pg_isready -q -h 127.0.0.1 -p "$PORT" -t 2\n';
    const address = yield* run({
      argv: ["sh", "-ec", `${ping}${containerAddress}\ncontainer_address`],
      env: { PORT: String(input.desired.port) },
    });
    if (address.exitCode !== 0)
      return yield* failure("The final database TCP listener is not ready.", address.exitCode, "transient");
    host = address.stdout.trim() || undefined;
    if (host === undefined) {
      return yield* failure(
        "Could not resolve the database container address.",
        address.exitCode,
        "transient",
      );
    }
  }
  const context = {
    service: service.name,
    family,
    port: input.desired.port,
    host: host ?? "127.0.0.1",
    failure,
    run,
    desired: {
      user: creds.user,
      database: creds.database,
      password,
      ...(rootPassword === undefined ? {} : { rootPassword }),
    },
    applied: {
      user: old.user,
      ...(oldPassword === undefined ? {} : { password: oldPassword }),
      ...(oldRoot === undefined ? {} : { rootPassword: oldRoot }),
    },
  } satisfies AdapterContext;
  const adapter = adapters[family](context);
  const managedAccess = managed === undefined ? undefined : adapter.managed;
  let managedWorks =
    managed !== undefined && managedAccess !== undefined && (yield* managedAccess.prove(managed));
  let admin =
    managedWorks && managed !== undefined
      ? managed
      : yield* chooseAdmin({
          context,
          adapter,
          register,
          ...(fallback === undefined ? {} : { fallback }),
        });
  // SQL Server can reject a login while starting up and accept it by the time
  // the sa proof succeeds. Do not use the earlier negative result to classify
  // an existing reserved login as a collision.
  if (family === "mssql" && !managedWorks && managed !== undefined && managedAccess !== undefined) {
    managedWorks = yield* managedAccess.prove(managed);
    if (managedWorks) admin = managed;
  }
  const delta = yield* adapter.delta(admin);
  const adoption =
    managed !== undefined && managedAccess !== undefined && !managedWorks
      ? yield* managedAccess.adoption(admin, managed)
      : undefined;
  const changedMembers = changed(delta);
  const siblings =
    changedMembers.includes("database") && adapter.listSiblings !== undefined
      ? (yield* adapter.listSiblings(admin)).filter((name) => name !== creds.database).sort()
      : undefined;
  const databaseCreation =
    siblings === undefined
      ? undefined
      : {
          database: creds.database,
          otherDatabases: siblings.slice(0, 16),
          omittedCount: Math.max(0, siblings.length - 16),
        };
  const summary = { service: service.name, family, changedMembers };
  const preview: DatabaseCredentialConvergenceResult = {
    ...summary,
    outcome: delta.length === 0 && adoption === undefined ? "already-matched" : "planned",
    ...(adoption === undefined ? {} : { adminAdoption: true }),
    ...(databaseCreation === undefined ? {} : { databaseCreation }),
  };
  const stale = targetError(
    "target-changed",
    "The database target or pending changes no longer match the preview.",
    service.name,
  );
  const sameObservation = Effect.fnUntraced(function* () {
    const current = yield* observeTarget(input);
    if (!Equal.equals(current, observed)) return yield* stale;
  });
  const apply = Effect.gen(function* () {
    if (delta.length === 0 && adoption === undefined) return preview;
    const store = yield* StateStore;
    return yield* withPhysicalVolumeLock(
      store,
      {
        key: observed.physical.coordinationKey,
        name: observed.physical.nativeName,
        mode: "exclusive",
      },
      Effect.gen(function* () {
        yield* sameObservation();
        const authenticated =
          managedWorks && managedAccess !== undefined
            ? yield* managedAccess.prove(admin)
            : (yield* adapter.admin(admin)) === "accepted";
        if (!authenticated || !Equal.equals(yield* adapter.delta(admin), delta)) return yield* stale;
        phase = "apply";
        if (adoption !== undefined && managedAccess !== undefined && managed !== undefined) {
          const confirmedAdoption = yield* managedAccess.adoption(admin, managed);
          if (!Equal.equals(adoption, confirmedAdoption)) return yield* stale;
          yield* sameObservation();
          yield* input.onMutationDispatch ?? Effect.void;
          possibleWrite = true;
          const result = yield* run(confirmedAdoption);
          if (result.exitCode !== 0 || !(yield* managedAccess.prove(managed))) {
            return yield* failure(
              "Could not establish the Lando-owned database administrator.",
              result.exitCode,
            );
          }
        }
        for (const step of delta) {
          yield* sameObservation();
          yield* input.onMutationDispatch ?? Effect.void;
          possibleWrite = true;
          const response = yield* run(step.request);
          if (response.exitCode !== 0)
            return yield* failure("The database declined a credential change.", response.exitCode);
          for (const member of step.members) completed.add(member);
        }
        phase = "verify";
        yield* sameObservation();
        const verifier =
          (family === "mssql" && admin.user === "sa" && changedMembers.includes("password")) ||
          ((family === "postgres" || family === "mongodb") &&
            admin.user === creds.user &&
            changedMembers.includes("password"))
            ? { ...admin, password }
            : isMysqlFamily &&
                admin.user === "root" &&
                rootPassword !== undefined &&
                changedMembers.includes("rootPassword")
              ? { ...admin, password: rootPassword }
              : admin;
        if (
          !(managed !== undefined && managedAccess !== undefined
            ? yield* managedAccess.prove(managed)
            : (yield* adapter.admin(verifier)) === "accepted") ||
          (yield* adapter.delta(managed ?? verifier)).length !== 0
        ) {
          return yield* failure("The database catalog or fresh login did not match the requested changes.");
        }
        return {
          ...preview,
          outcome: "applied",
        } satisfies DatabaseCredentialConvergenceResult;
      }),
    ).pipe(
      mapFailures((error) =>
        error._tag === "StateStoreError" ? failure("Could not lock the database volume.") : error,
      ),
    );
  });
  return { preview, apply, volume: observed.physical };
});
