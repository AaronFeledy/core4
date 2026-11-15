import { captureCommandOutput } from "@lando/container-runtime/command-output";
import { classifyCredentialLiterals, planCredentialClassification } from "@lando/redaction/plan-values";
import { RedactionService } from "@lando/redaction/service";
import {
  type DatabaseClientCheckState,
  type DatabaseClientCreds,
  type DatabaseFamily,
  classifyDatabaseClientResult,
  databaseLocalCheck,
} from "@lando/sdk/database-creds";
import {
  type AppPlan,
  type EnvironmentValue,
  ServiceName,
  type ServicePlan,
  type ServiceState,
  isActiveRunStatus,
  planAppIdentity,
} from "@lando/sdk/schema";
import type {
  EnvironmentValueResolverSession,
  ExecChunk,
  RuntimeProviderShape,
  ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { Duration, Effect, Option, Ref, Result, Stream } from "effect";

export type DatabaseLogin = "app" | "root";

/** One family/login observation. `unverified` is absence of proof, never a rejection. */
export interface DatabaseCredentialOutcome {
  readonly service: string;
  readonly family: DatabaseFamily;
  readonly login: DatabaseLogin;
  readonly state: DatabaseClientCheckState;
  readonly detail?: string;
  readonly changedMembers: readonly string[];
}

export interface DatabaseCredentialCheckInput {
  readonly provider: Pick<RuntimeProviderShape, "execStream">;
  readonly plan: AppPlan;
  readonly services: ReadonlyArray<{ readonly name: string; readonly state: ServiceState }>;
  readonly session: EnvironmentValueResolverSession;
  /** The plan the provider had applied before this operation, when one exists. */
  readonly previousPlan?: AppPlan;
  /**
   * Whole-check budget. Checks that finish keep their verdict; checks still running when it
   * expires are reported as `unverified` with the expiry as their reason.
   */
  readonly budgetMs?: number;
}

const DEFAULT_BUDGET_MS = 10_000;
const CHECK_CONCURRENCY = 4;
const DETAIL_LIMIT = 300;
/** Grace past the client's own timeout before the exec itself counts as hung. */
const CAPTURE_GRACE_MS = 1_000;
/** Same bound the diagnostic tail keeps, so classification sees at least what a report would. */
const RAW_TAIL_LIMIT = 8 * 1024;

const CREDENTIAL_MEMBERS = ["user", "password", "database", "rootPassword"] as const;

const CHECKABLE_STATES: ReadonlySet<ServiceState> = new Set<ServiceState>([
  "running",
  "healthy",
  "ready",
  "unhealthy",
]);

const descriptor = (value: EnvironmentValue | undefined): string =>
  value === undefined ? "" : JSON.stringify(value);

/** Descriptor-only comparison: reading a reference here would resolve it. */
export const changedCredentialMembers = (
  previous: ServicePlan | undefined,
  current: ServicePlan,
): readonly string[] => {
  const before = previous?.connection?.creds;
  const after = current.connection?.creds;
  if (before === undefined || after === undefined) return [];
  return CREDENTIAL_MEMBERS.filter((member) => descriptor(before[member]) !== descriptor(after[member]));
};

/** Creds or primary-port descriptors changed between two plans, compared without resolving either. */
export const connectionChanged = (previous: ServicePlan | undefined, current: ServicePlan): boolean => {
  if (previous?.connection === undefined || current.connection === undefined) return false;
  return (
    changedCredentialMembers(previous, current).length > 0 ||
    previous.connection.port !== current.connection.port
  );
};

export interface DatabaseCredentialScopeInput {
  readonly plan: AppPlan;
  /** The plan the provider had applied before this operation, when one exists. */
  readonly previousPlan?: AppPlan;
  /** Observations taken before the apply, from the one list call start already makes. */
  readonly before: ReadonlyArray<ServiceRuntimeInfo>;
  /** Runtime observations taken after the apply, keyed by service name. */
  readonly after: ReadonlyMap<string, ServiceRuntimeInfo>;
}

/**
 * The database services whose observed answer this operation can change: ones it created,
 * recreated, or started, ones with no pre-apply applied plan entry, and ones whose connection
 * descriptors changed. A service that was already running unchanged is left to `lando doctor`.
 */
export const databaseCredentialCheckScope = (input: DatabaseCredentialScopeInput): readonly string[] => {
  const appRoot = planAppIdentity(input.plan).appRoot;
  const before = new Map(
    input.before
      .filter(
        (observation) =>
          observation.containerId !== undefined &&
          observation.app === input.plan.id &&
          observation.appRoot === appRoot,
      )
      .map((observation) => [String(observation.service), observation]),
  );
  return Object.values(input.plan.services)
    .filter((service) => {
      if (service.connection === undefined) return false;
      const previous = input.previousPlan?.services[service.name];
      if (previous === undefined || connectionChanged(previous, service)) return true;
      const prior = before.get(String(service.name));
      if (prior === undefined || !isActiveRunStatus(prior.status)) return true;
      const containerId = input.after.get(String(service.name))?.containerId;
      return containerId === undefined || containerId !== prior.containerId;
    })
    .map((service) => String(service.name));
};

interface LoginCheck {
  readonly service: string;
  readonly family: DatabaseFamily;
  readonly login: DatabaseLogin;
  readonly changedMembers: readonly string[];
  readonly creds: DatabaseClientCreds;
}

/** What one capture proves: the client's exit code, and its separately redacted evidence. */
interface CapturedCheck {
  readonly exitCode: number | undefined;
  readonly stderr: string;
}

const loginChecks = (service: ServicePlan, previousPlan: AppPlan | undefined): readonly LoginCheck[] => {
  const connection = service.connection;
  if (connection === undefined) return [];
  const identity = {
    service: String(service.name),
    family: connection.family,
    changedMembers: changedCredentialMembers(previousPlan?.services[service.name], service),
  };
  const app: LoginCheck = {
    ...identity,
    login: "app",
    creds: { ...connection.creds, port: connection.port },
  };
  const rootPassword = connection.creds.rootPassword;
  if ((connection.family !== "mysql" && connection.family !== "mariadb") || rootPassword === undefined)
    return [app];
  return [
    app,
    {
      ...identity,
      login: "root",
      creds: {
        user: "root",
        password: rootPassword,
        database: connection.creds.database,
        port: connection.port,
      },
    },
  ];
};

const boundedDetail = (stderr: string): string | undefined => {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return undefined;
  return line.length <= DETAIL_LIMIT ? line : `${line.slice(0, DETAIL_LIMIT)}...`;
};

/**
 * A bounded copy of the client's own stderr, kept only until classification reads it. Redaction
 * rewrites the diagnostic tail the operation keeps, so a password that is also a word in the
 * rejection text would otherwise erase the signal. Callers classify and drop the text.
 */
const rawDiagnosticTail = () => {
  const decoder = new TextDecoder();
  let text = "";
  return {
    observe: (chunk: ExecChunk) => {
      if ("exitCode" in chunk || chunk.kind !== "stderr") return;
      text += decoder.decode(chunk.chunk, { stream: true });
      if (text.length > RAW_TAIL_LIMIT) text = text.slice(-RAW_TAIL_LIMIT);
    },
    text: () => `${text}${decoder.decode()}`.slice(-RAW_TAIL_LIMIT),
  };
};

const registerCredentialRedaction = Effect.fnUntraced(function* (
  plan: AppPlan,
  password: EnvironmentValue,
  session: EnvironmentValueResolverSession,
) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isNone(redaction)) return;
  const tiers = classifyCredentialLiterals(planCredentialClassification(plan), [password]);
  yield* redaction.value.registerValues(tiers.substring);
  yield* redaction.value.registerValues(tiers.wholeToken, { match: "whole-token" });
  if (typeof password === "string") return;
  const resolved = yield* Effect.result(session.resolveEnvironment({ LANDO_DB_CREDENTIAL_CHECK: password }));
  if (Result.isFailure(resolved)) return;
  const value = resolved.success.LANDO_DB_CREDENTIAL_CHECK;
  if (value === undefined || value.length === 0) return;
  yield* redaction.value.registerValues([value]);
});

const checkLogin = Effect.fnUntraced(function* (input: DatabaseCredentialCheckInput, check: LoginCheck) {
  const { creds, ...identity } = check;
  const spec = databaseLocalCheck(check.family, creds);
  const resolved = yield* Effect.result(input.session.resolveEnvironment(spec.environment));
  if (Result.isFailure(resolved))
    return { ...identity, state: "unverified" } satisfies DatabaseCredentialOutcome;
  yield* registerCredentialRedaction(input.plan, creds.password, input.session);
  // Classification needs the bytes the client wrote, but redaction has already rewritten the
  // diagnostic tail. This bounded copy exists only to classify: the verdict leaves, the text does not.
  const raw = rawDiagnosticTail();
  const captured = yield* captureCommandOutput(
    input.provider
      .execStream(
        { app: input.plan.id, service: ServiceName.make(check.service), plan: input.plan },
        { command: spec.argv, env: resolved.success },
      )
      .pipe(Stream.tap((chunk) => Effect.sync(() => raw.observe(chunk)))),
    { stdout: "discard", failure: (evidence) => evidence },
  ).pipe(
    Effect.map((result): CapturedCheck => ({ exitCode: result.exitCode, stderr: "" })),
    Effect.catch((evidence) =>
      Effect.succeed<CapturedCheck>({ exitCode: evidence.exitCode, stderr: evidence.stderrTail ?? "" }),
    ),
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(spec.timeoutMs + CAPTURE_GRACE_MS)),
  );
  if (Option.isNone(captured))
    return { ...identity, state: "unverified", detail: "timed out" } satisfies DatabaseCredentialOutcome;
  const state =
    captured.value.exitCode === undefined
      ? "unverified"
      : classifyDatabaseClientResult(check.family, {
          exitCode: captured.value.exitCode,
          stderr: raw.text(),
        });
  const detail = state === "accepted" ? undefined : boundedDetail(captured.value.stderr);
  return {
    ...identity,
    state,
    ...(detail === undefined ? {} : { detail }),
  } satisfies DatabaseCredentialOutcome;
});

/**
 * Run one authenticated local check per observed database service, plus the MySQL/MariaDB
 * administrator login when the connection carries one. Callers pass only the services whose
 * answer can have changed. A failed or unavailable check is reported as `unverified`; this
 * effect never fails app start.
 */
export const checkDatabaseCredentials = Effect.fn("DatabaseCredentials.check")(function* (
  input: DatabaseCredentialCheckInput,
) {
  const observed = new Map(input.services.map((service) => [service.name, service.state]));
  const checks = Object.values(input.plan.services).flatMap((service) =>
    CHECKABLE_STATES.has(observed.get(String(service.name)) ?? "stopped")
      ? loginChecks(service, input.previousPlan)
      : [],
  );
  if (checks.length === 0) return [];
  // Each finished check records its own verdict, so an expiring budget cannot discard a
  // rejection another check already proved. Unfinished checks stay explicitly unproven.
  const finished = yield* Ref.make<ReadonlyMap<number, DatabaseCredentialOutcome>>(new Map());
  yield* Effect.forEach(
    checks,
    (check, index) =>
      checkLogin(input, check).pipe(
        Effect.tap((outcome) => Ref.update(finished, (current) => new Map(current).set(index, outcome))),
      ),
    { concurrency: CHECK_CONCURRENCY },
  ).pipe(Effect.timeoutOption(Duration.millis(input.budgetMs ?? DEFAULT_BUDGET_MS)));
  const recorded = yield* Ref.get(finished);
  return checks.map(
    (check, index): DatabaseCredentialOutcome =>
      recorded.get(index) ??
      ({
        service: check.service,
        family: check.family,
        login: check.login,
        state: "unverified",
        detail: "the credential check budget expired before this login was observed",
        changedMembers: check.changedMembers,
      } satisfies DatabaseCredentialOutcome),
  );
});

const guideUrl = (family: DatabaseFamily): string =>
  `https://docs.lando.dev/guides/services/${family}#recover-when-credentials-dont-match`;

/** One recovery sentence shared by start warnings, readiness remediation, and doctor. */
export const databaseCredentialRemediation = (
  family: DatabaseFamily,
  state: Exclude<DatabaseClientCheckState, "accepted" | "unverified">,
): string =>
  state === "rejected"
    ? `Restore the previous creds values and run \`lando start\`, or change the user inside the database with an administrator account. Data is retained. See ${guideUrl(family)}.`
    : `Create the database or grant the configured user access with an administrator account, then retry. Data is retained. See ${guideUrl(family)}.`;
