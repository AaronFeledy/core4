import {
  ServiceStartError,
  type SqlCredentialAdminAuthError,
  type SqlCredentialApplyError,
  type SqlCredentialMember,
  type SqlCredentialTargetError,
} from "@lando/sdk/errors";
import type { AppPlan, DatabaseConnection, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ApplyOptions, ApplyResult } from "@lando/sdk/services";
import { catalogCandidate } from "../operations/database-convergence/catalog.ts";
import { connectionChanged } from "../operations/database-credentials.ts";

export type HealthyContinuation = NonNullable<ApplyOptions["continueHealthyDependency"]>;
type HealthyDependency = Parameters<HealthyContinuation>[0];

export type DatabaseTarget = {
  readonly service: ServicePlan;
  readonly connection: DatabaseConnection;
  readonly isCatalogCandidate: () => boolean;
};

export type CredentialFailure = {
  readonly reason:
    | SqlCredentialAdminAuthError["reason"]
    | SqlCredentialApplyError["phase"]
    | SqlCredentialTargetError["reason"]
    | "timeout"
    | "timeout-after-mutation"
    | "unavailable";
  readonly detail: string;
  readonly guidance?: string;
  readonly mutation?: SqlCredentialApplyError["mutation"];
  readonly completed?: SqlCredentialApplyError["completed"];
  readonly exitCode?: number;
};

export type CredentialAttempt =
  | {
      readonly kind: "verified";
      readonly change?: {
        readonly service: string;
        readonly family: DatabaseConnection["family"];
        readonly changedMembers: readonly SqlCredentialMember[];
      };
    }
  | { readonly kind: "failed"; readonly failure: CredentialFailure }
  | { readonly kind: "unproven-build" };

export const activationDatabaseTargets = (
  plan: AppPlan,
  retained: readonly ServicePlan[],
): ReadonlyMap<ServiceName, DatabaseTarget> => {
  const targets = new Map<ServiceName, DatabaseTarget>();
  for (const service of Object.values(plan.services)) {
    if (service.connection === undefined) continue;
    targets.set(service.name, {
      service,
      connection: service.connection,
      isCatalogCandidate: () => catalogCandidate({ plan, service, retained }) !== undefined,
    });
  }
  return targets;
};

export const credentialWorkAfterApply = (
  target: DatabaseTarget,
  input: {
    readonly action: NonNullable<ApplyResult["services"]>[string]["action"] | undefined;
    readonly previous: ServicePlan | undefined;
    readonly attempted: CredentialAttempt | undefined;
  },
): "skip" | "observe" | "converge" => {
  const { action, previous, attempted } = input;
  if (attempted?.kind === "unproven-build") return "observe";
  if (attempted !== undefined || action === undefined) return "skip";
  if (action === "kept") {
    if (previous === undefined) return target.isCatalogCandidate() ? "converge" : "skip";
    if (!connectionChanged(previous, target.service)) return "skip";
  }
  return target.isCatalogCandidate() ? "converge" : "observe";
};

export const unprovenBuildDetail = "The database image's catalog provenance could not be verified.";

export const credentialGateFailure = (
  result: CredentialAttempt | undefined,
): CredentialFailure | undefined => {
  switch (result?.kind) {
    case "unproven-build":
      return {
        reason: "unsupported-target",
        detail: unprovenBuildDetail,
        guidance: "Use the bundled catalog image.",
      };
    case "failed":
      return result.failure;
    case "verified":
    case undefined:
      return undefined;
  }
};

export const credentialRecovery = (failure: CredentialFailure) => {
  const recovery =
    failure.mutation === "possible" || failure.mutation === "partial"
      ? "A database write may have taken effect. Inspect the database for partial changes and resolve any you find."
      : (failure.guidance ?? "Fix the database or its configuration.");
  return `${recovery} Retry the same command with the same selection. Do not delete the database volume.`;
};

export const credentialGateError = (
  providerId: ServiceStartError["providerId"],
  { consumer, dependency }: HealthyDependency,
  failure: CredentialFailure,
) => {
  const { reason, detail, mutation, completed, exitCode } = failure;
  const changes =
    completed === undefined || completed.length === 0
      ? ""
      : ` The database acknowledged changes to: ${completed.join(", ")}.`;
  return new ServiceStartError({
    providerId,
    operation: "database-credential-convergence",
    service: consumer,
    details: {
      dependency,
      reason,
      ...(mutation === undefined ? {} : { mutation }),
      ...(completed === undefined ? {} : { completed }),
      ...(exitCode === undefined ? {} : { exitCode }),
    },
    message: `Cannot start ${consumer}: Lando could not prepare credentials for database ${dependency}. ${detail}${changes}`,
    remediation: credentialRecovery(failure),
  });
};
