import { isPlainRecord } from "@lando/sdk/landofile";
import { AppId, AppliedAppPlan } from "@lando/sdk/schema";
import { Schema } from "effect";
import { visitAppliedNetworkVocabulary } from "./applied-network-vocabulary.ts";
import { AppliedStateMigrationError, appliedStateIssue } from "./applied-state-read.ts";

const currentPlanIssue = (raw: unknown) => {
  const checked = visitAppliedNetworkVocabulary(raw, false);
  return typeof checked === "string" ? checked : undefined;
};

const currentMapIssue = (raw: unknown) => {
  if (!isPlainRecord(raw)) return "apps";
  for (const [index, [id, plan]] of Object.entries(raw).entries()) {
    if (!isPlainRecord(plan) || !Object.hasOwn(plan, "id") || plan.id !== id) return `apps[${index}].id`;
    const issue = currentPlanIssue(plan);
    if (issue !== undefined) return `apps[${index}].${issue}`;
  }
  return undefined;
};

const checkedAppliedPayload = (check: (raw: unknown) => string | undefined) =>
  Schema.Unknown.check(
    Schema.makeFilter((raw) => {
      const issue = check(raw);
      return issue === undefined ? undefined : appliedStateIssue(issue);
    }),
  );

export const AppliedPlan = checkedAppliedPayload(currentPlanIssue).pipe(Schema.decodeTo(AppliedAppPlan));
export const AppliedPlans = checkedAppliedPayload(currentMapIssue).pipe(
  Schema.decodeTo(Schema.Record(AppId, AppliedAppPlan)),
);

export const requireMigrated = <A>(result: A | string, fromVersion: number): A => {
  if (typeof result === "string") throw new AppliedStateMigrationError(fromVersion, result);
  return result;
};
