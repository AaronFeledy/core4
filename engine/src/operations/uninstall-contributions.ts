import { causeMessage } from "@lando/sdk/errors";
import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import type {
  HostPlatform,
  HostUninstallOutcome,
  HostUninstallStep,
  UninstallStepResult,
} from "@lando/sdk/schema";
import type { PrivilegeService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import type { HostMaintenanceRegistryShape } from "../runtime/host-maintenance";
import type { UninstallMode, UninstallPlanStep, UninstallStepOutcome } from "./uninstall.ts";

const BUILT_IN_UNINSTALL_STEP_IDS = [
  "running-apps",
  "managed-provider-machines",
  "podman-network-definitions",
  "runtime-service",
  "managed-provider-runtime",
  "mutagen-binary",
  "mutagen-agents",
  "ca-trust",
  "global-app-state",
  "caches",
  "host-proxy-sessions",
  "installed-binary",
  "cgroups-delegate",
  "shell-entries",
  "user-conf-root",
  "user-data-root",
  "user-cache-root",
  "install-record",
] as const;

const builtInIdSet: ReadonlySet<string> = new Set(BUILT_IN_UNINSTALL_STEP_IDS);

export class UninstallContributionConflictError extends Schema.TaggedError<UninstallContributionConflictError>()(
  "UninstallContributionConflictError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    maintainerId: Schema.String,
    stepId: Schema.String,
    reason: Schema.Literals(["duplicate", "reserved"]),
  },
) {}

export interface ContributionBinding {
  readonly maintainerId: string;
  readonly localStep: HostUninstallStep;
  readonly uninstall: NonNullable<HostMaintenanceContribution["uninstall"]>;
}

export type ElevateCapability = PrivilegeService["Service"]["elevate"];

export const contributedStepId = (maintainerId: string, localStepId: string): string =>
  `${maintainerId}:${localStepId}`;

const applyKeepDataPreservation = (
  step: HostUninstallStep,
  mode: UninstallMode | undefined,
): HostUninstallStep => {
  if (mode !== "keep-data" || step.preserveOnKeepData !== true) return step;
  return {
    ...step,
    status: "skipped",
    detail: "Preserved by --keep-data; rerun with --purge to remove this host-maintained resource.",
  };
};

const toPlanStep = (maintainerId: string, local: HostUninstallStep): UninstallPlanStep => ({
  id: contributedStepId(maintainerId, local.id),
  label: local.label,
  target: local.target,
  destructive: local.destructive,
  status: local.status,
  detail: local.detail,
});

export const planHostUninstallContributions = (
  registry: HostMaintenanceRegistryShape | undefined,
  input: {
    readonly platform: HostPlatform;
    readonly userDataRoot: string;
    readonly mode?: UninstallMode;
  },
): Effect.Effect<
  {
    readonly steps: ReadonlyArray<UninstallPlanStep>;
    readonly bindings: ReadonlyMap<string, ContributionBinding>;
  },
  UninstallContributionConflictError
> => {
  if (registry === undefined) {
    return Effect.succeed({ steps: [], bindings: new Map() });
  }

  return Effect.gen(function* () {
    const steps: UninstallPlanStep[] = [];
    const bindings = new Map<string, ContributionBinding>();
    const seen = new Set<string>();

    for (const maintainer of registry.maintainers) {
      const uninstall = maintainer.uninstall;
      if (uninstall === undefined) continue;

      const planned = yield* uninstall.plan({
        platform: input.platform,
        userDataRoot: input.userDataRoot,
      });

      for (const raw of planned) {
        const local = applyKeepDataPreservation(raw, input.mode);
        if (builtInIdSet.has(local.id)) {
          return yield* Effect.fail(
            new UninstallContributionConflictError({
              message: `Host maintainer "${maintainer.id}" contributed reserved uninstall step id "${local.id}".`,
              remediation:
                "Rename the contributed step id so it does not collide with a built-in uninstall step, then rerun uninstall.",
              maintainerId: maintainer.id,
              stepId: local.id,
              reason: "reserved",
            }),
          );
        }

        const composite = contributedStepId(maintainer.id, local.id);
        if (seen.has(composite)) {
          return yield* Effect.fail(
            new UninstallContributionConflictError({
              message: `Duplicate host uninstall step id "${composite}" from maintainer "${maintainer.id}".`,
              remediation: "Ensure each host maintainer contributes unique step ids, then rerun uninstall.",
              maintainerId: maintainer.id,
              stepId: local.id,
              reason: "duplicate",
            }),
          );
        }
        seen.add(composite);

        steps.push(toPlanStep(maintainer.id, local));
        bindings.set(composite, {
          maintainerId: maintainer.id,
          localStep: local,
          uninstall,
        });
      }
    }

    return { steps, bindings };
  });
};

export const conflictResultStep = (error: UninstallContributionConflictError): UninstallStepResult => ({
  id: "host-maintenance-contributions",
  label: "host maintenance contributions",
  target: contributedStepId(error.maintainerId, error.stepId),
  destructive: false,
  status: "manual",
  detail: `${error.message} ${error.remediation}`,
  outcome: "failed",
  error: error.message,
});

export const executeHostUninstallContribution = (
  binding: ContributionBinding,
  input: {
    readonly platform: HostPlatform;
    readonly userDataRoot: string;
    readonly elevate?: ElevateCapability;
  },
): Effect.Effect<HostUninstallOutcome> => {
  const { localStep, uninstall } = binding;
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      uninstall.execute({
        platform: input.platform,
        userDataRoot: input.userDataRoot,
        step: localStep,
        ...(input.elevate === undefined ? {} : { elevate: input.elevate }),
      }),
    );
    if (exit._tag === "Failure") {
      return { outcome: "failed" as const, error: causeMessage(exit.cause) };
    }
    const result = exit.value;
    // Rebuild from known fields: the caller spreads this over the plan step, so
    // extra keys a plugin returns (status, id) must not overwrite plan fields.
    const detail = result.detail === undefined ? {} : { detail: result.detail };
    switch (result.outcome) {
      case "completed":
        return { outcome: "completed", ...detail };
      case "skipped":
        return { outcome: "skipped", ...detail };
      case "manual":
        return { outcome: "manual", detail: result.detail };
      case "failed":
        return { outcome: "failed", error: result.error, ...detail };
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  });
};

/** True when an originally-owned contribution must block user-data-root deletion.
 * SDK execute outcomes do not prove absence on non-completed results (including
 * skipped), so any non-completed outcome from an owned plan step preserves the root.
 */
export const contributionBlocksUserDataRoot = (
  plannedStatus: UninstallPlanStep["status"],
  outcome: UninstallStepOutcome,
): boolean => plannedStatus === "owned" && outcome !== "completed";
