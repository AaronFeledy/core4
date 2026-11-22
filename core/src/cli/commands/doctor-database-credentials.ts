import { resolveAppliedStateTarget } from "@lando/engine/operations/applied-state-target";
import {
  type DatabaseCredentialOutcome,
  checkDatabaseCredentials,
  databaseCredentialRemediation,
} from "@lando/engine/operations/database-credentials";
import { EnvironmentValueResolver, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Clock, Effect, Option } from "effect";
import type { DoctorFinding, DoctorSectionResult, DoctorSkipInput } from "./doctor-contract";
import { isolateDoctorSection } from "./doctor-self";

const skippedSection = (reason: string): DoctorSectionResult => ({
  checks: [],
  skipped: [{ reason }],
});

/** Leave the section budget room to turn the check's own budget expiry into explicit skips. */
const CHECK_BUDGET_RESERVE_MS = 250;
/** A section already close to its deadline still gets a measured check, never an instant write-off. */
const CHECK_BUDGET_MIN_MS = 50;

/**
 * The check owns a budget inside the section's, so an expiry is a per-login skip, not a lost section.
 * It starts when the checks do, not when the section did: resolving the target, observing the
 * provider, listing services, and opening the session have already spent part of the section's
 * budget. A budget derived from the section's full duration would outlive that deadline and
 * discard findings the checks had already completed.
 */
const checkBudgetMs = (sectionBudgetMs: number, elapsedMs: number): number =>
  Math.max(CHECK_BUDGET_MIN_MS, sectionBudgetMs - elapsedMs - CHECK_BUDGET_RESERVE_MS);

const result = (checks: ReadonlyArray<DoctorFinding>, skipped: ReadonlyArray<DoctorSkipInput>) =>
  ({ checks, ...(skipped.length === 0 ? {} : { skipped }) }) satisfies DoctorSectionResult;

const collect = Effect.fnUntraced(function* (redact: (value: string) => string, sectionBudgetMs: number) {
  const startedAtMs = yield* Clock.currentTimeMillis;
  const target = yield* resolveAppliedStateTarget;
  if (target === undefined)
    return skippedSection("No applied plan was found for the current app; no credentials were checked.");
  const databaseServices = Object.values(target.plan.services).filter(
    (service) => service.connection !== undefined,
  );
  if (databaseServices.length === 0)
    return skippedSection("The applied plan publishes no database connection facts.");
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(target.plan);
  if ((yield* provider.getStatus).state === "idle")
    return skippedSection(
      `Provider ${provider.id} holding the applied app is idle; no database logins were checked.`,
    );
  const running = yield* provider.list({ app: target.plan.id });
  const runningNames = new Set(
    running.filter((entry) => entry.status === "running").map((entry) => String(entry.service)),
  );
  const checkable: { readonly name: string; readonly state: "running" }[] = [];
  const checks: DoctorFinding[] = [];
  const skipped: DoctorSkipInput[] = [];
  for (const service of databaseServices) {
    const name = String(service.name);
    if (runningNames.has(name)) checkable.push({ name, state: "running" });
    else
      skipped.push({
        check: `database-credentials:${name}`,
        reason: "The service is not running; no credential check was attempted.",
      });
  }
  if (checkable.length === 0) return result(checks, skipped);
  const resolver = yield* Effect.serviceOption(EnvironmentValueResolver);
  if (Option.isNone(resolver)) {
    // A running service whose check never ran is still an explicit skip, never silence.
    for (const service of checkable)
      skipped.push({
        check: `database-credentials:${service.name}`,
        reason:
          "The environment session that resolves credential values was unavailable; no login was observed.",
      });
    return result(checks, skipped);
  }
  const session = yield* resolver.value.openSession();
  const elapsedMs = (yield* Clock.currentTimeMillis) - startedAtMs;
  const outcomes = yield* checkDatabaseCredentials({
    provider,
    plan: target.plan,
    services: checkable,
    session,
    budgetMs: checkBudgetMs(sectionBudgetMs, elapsedMs),
  });
  for (const outcome of outcomes) {
    const finding = findingFor(outcome, String(target.plan.id), redact);
    if (finding === undefined)
      skipped.push({
        check: `database-credentials:${outcome.service}:${outcome.login}`,
        reason: `The ${outcome.login} login check was unverified${outcome.detail === undefined ? "" : `: ${outcome.detail}`}. This is not evidence of a missing database or a rejected password.`,
      });
    else checks.push(finding);
  }
  return result(checks, skipped);
});

const findingFor = (
  outcome: DatabaseCredentialOutcome,
  app: string,
  redact: (value: string) => string,
): DoctorFinding | undefined => {
  switch (outcome.state) {
    case "unverified":
      return undefined;
    case "accepted":
    case "rejected":
    case "database-missing": {
      const accepted = outcome.state === "accepted";
      const message = accepted
        ? `The running ${outcome.family} service accepted the local query with the configured ${outcome.login} login. That proves the query was accepted, not that the stored password was validated.`
        : `The running ${outcome.family} service rejected the local query with the configured ${outcome.login} login${outcome.state === "database-missing" ? ": the configured database is absent or inaccessible" : ""}.`;
      return {
        name: "database-credentials",
        subject: redact(`${app}/${outcome.service}:${outcome.login}`),
        status: accepted ? "pass" : "warn",
        severity: accepted ? "info" : "warn",
        context: {
          app: redact(app),
          service: redact(outcome.service),
          family: outcome.family,
          login: outcome.login,
          ...(outcome.changedMembers.length === 0
            ? {}
            : { changedMembers: outcome.changedMembers.map((member) => `creds.${member}`).join(",") }),
          ...(outcome.detail === undefined ? {} : { clientMessage: redact(outcome.detail) }),
          finding: redact(message),
        },
        solutions:
          outcome.state === "accepted"
            ? []
            : [
                {
                  kind: "manual",
                  description: redact(
                    databaseCredentialRemediation(outcome.family, outcome.state, outcome.service),
                  ),
                },
              ],
      };
    }
    default:
      return outcome.state satisfies never;
  }
};

export const databaseCredentialsDoctorChecks = Effect.fnUntraced(function* (input: {
  readonly budgetMs: number;
  readonly redact: (value: string) => string;
}) {
  const outcome = yield* isolateDoctorSection({
    section: "database-credentials",
    effect: Effect.scoped(collect(input.redact, input.budgetMs)),
    fallback: skippedSection(
      "Database credential checks could not complete within their budget or were unavailable; no login verdict was made.",
    ),
    budgetMs: input.budgetMs,
    redact: input.redact,
  });
  return outcome.self === undefined
    ? outcome.value
    : skippedSection(`${outcome.self.context.reason}: ${outcome.self.context.message}`);
});
