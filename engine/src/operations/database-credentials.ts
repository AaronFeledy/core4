import { captureCommandOutput } from "@lando/container-runtime/command-output";
import { classifyCredentialLiterals, planCredentialClassification } from "@lando/redaction/plan-values";
import { RedactionService } from "@lando/redaction/service";
import { withDeadline } from "@lando/sdk/command-result";
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
} from "@lando/sdk/schema";
import type { EnvironmentValueResolverSession, ExecChunk, RuntimeProviderShape } from "@lando/sdk/services";
import { Duration, Effect, Option, Ref, Result, Stream } from "effect";
import { settleOrdinaryFailure } from "../lifecycle/failure-compensation.ts";

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
  if (current.connection === undefined) return false;
  if (previous?.connection === undefined) return previous !== undefined;
  return (
    changedCredentialMembers(previous, current).length > 0 ||
    previous.connection.family !== current.connection.family ||
    previous.connection.port !== current.connection.port
  );
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
  const resolved = yield* settleOrdinaryFailure(
    session.resolveEnvironment({ LANDO_DB_CREDENTIAL_CHECK: password }),
  );
  if (Result.isFailure(resolved)) return;
  const value = resolved.success.LANDO_DB_CREDENTIAL_CHECK;
  if (value === undefined || value.length === 0) return;
  yield* redaction.value.registerValues([value]);
});

const checkLogin = Effect.fnUntraced(function* (input: DatabaseCredentialCheckInput, check: LoginCheck) {
  const { creds, ...identity } = check;
  const spec = databaseLocalCheck(check.family, creds);
  const resolved = yield* settleOrdinaryFailure(input.session.resolveEnvironment(spec.environment));
  if (Result.isFailure(resolved))
    return { ...identity, state: "unverified" } satisfies DatabaseCredentialOutcome;
  yield* registerCredentialRedaction(input.plan, creds.password, input.session);
  // Classification needs the bytes the client wrote, but redaction has already rewritten the
  // diagnostic tail. This bounded copy exists only to classify: the verdict leaves, the text does not.
  const raw = rawDiagnosticTail();
  const work = settleOrdinaryFailure(
    captureCommandOutput(
      input.provider
        .execStream(
          { app: input.plan.id, service: ServiceName.make(check.service), plan: input.plan },
          { command: spec.argv, env: resolved.success },
        )
        .pipe(Stream.tap((chunk) => Effect.sync(() => raw.observe(chunk)))),
      { stdout: "discard", preserveDefects: true, failure: (evidence) => evidence },
    ),
  ).pipe(
    Effect.map(
      (result): CapturedCheck =>
        Result.isSuccess(result)
          ? { exitCode: result.success.exitCode, stderr: "" }
          : { exitCode: result.failure.exitCode, stderr: result.failure.stderrTail ?? "" },
    ),
    Effect.scoped,
  );
  const captured = yield* withDeadline(work, Duration.millis(spec.timeoutMs + CAPTURE_GRACE_MS));
  if (captured._tag === "TimedOut")
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
 * answer can have changed. Ordinary negative observations stay verdicts; exceptional causes propagate.
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
  yield* withDeadline(
    Effect.forEach(
      checks,
      (check, index) =>
        checkLogin(input, check).pipe(
          Effect.tap((outcome) => Ref.update(finished, (current) => new Map(current).set(index, outcome))),
        ),
      { concurrency: CHECK_CONCURRENCY, discard: true },
    ),
    Duration.millis(input.budgetMs ?? DEFAULT_BUDGET_MS),
  );
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

export const databaseCredentialGuide = (family: DatabaseFamily): string =>
  `https://docs.lando.dev/guides/services/${family}#recover-when-credentials-dont-match`;

/** Doctor observes an already applied app; activation advises retrying the current selection. */
export const databaseCredentialRemediation = (
  family: DatabaseFamily,
  state: Exclude<DatabaseClientCheckState, "accepted" | "unverified">,
  service = "<svc>",
): string =>
  `${state === "database-missing" ? "Check that creds.database names the database you intend to use. " : ""}If you edited creds, run \`lando start\`. If you rotated a referenced secret without changing the Landofile, or the running database drifted, run \`lando restart --service ${service}\`. To inspect a repair, run \`lando db:creds:apply --service ${service}\`, then add \`--yes\` to apply. See ${databaseCredentialGuide(family)}.`;
