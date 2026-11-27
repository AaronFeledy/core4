import { causeMessage } from "@lando/sdk/errors";
import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import type {
  HostChangeReceipt,
  HostPlatform,
  HostUninstallOutcome,
  HostUninstallStep,
  UninstallStepResult,
} from "@lando/sdk/schema";
import type { HostChangeStepRunner, PrivilegeService } from "@lando/sdk/services";
import { Effect, type Exit, Schema } from "effect";

import type { HostChangeReceiptStore } from "../host-changes/receipts.ts";
import type { HostMaintenanceRegistryShape } from "../runtime/host-maintenance";
import type { UninstallMode, UninstallPlanStep, UninstallStepOutcome } from "./uninstall.ts";
import { gateContributedUndo, keepDataDetail } from "./uninstall-host-changes.ts";

const BUILT_IN_UNINSTALL_STEP_IDS = [
  "running-apps",
  "managed-provider-machines",
  "podman-network-definitions",
  "runtime-service",
  "managed-provider-runtime",
  "mutagen-binary",
  "mutagen-agents",
  "global-app-state",
  "caches",
  "host-proxy-sessions",
  "installed-binary",
  "shell-entries",
  "user-conf-root",
  "user-data-root",
  "user-cache-root",
  "install-record",
  "host-change-receipts",
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
  readonly receipts: ReadonlyArray<HostChangeReceipt>;
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
  return { ...step, status: "skipped", detail: keepDataDetail(step) };
};

/** A step that undoes a recorded change is listed under the receipt's id, the one `--undo` takes. */
const planStepId = (
  maintainerId: string,
  local: HostUninstallStep,
  receipts: ReadonlyArray<HostChangeReceipt>,
): string =>
  local.receiptId !== undefined && receipts.some(({ id }) => id === local.receiptId)
    ? String(local.receiptId)
    : contributedStepId(maintainerId, local.id);

const toPlanStep = (id: string, local: HostUninstallStep): UninstallPlanStep => ({
  id,
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
    readonly receipts: ReadonlyArray<HostChangeReceipt>;
    readonly undo: ReadonlyArray<string>;
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

      const receipts = input.receipts.filter(({ owner }) => owner === maintainer.pluginId);
      const planned = yield* uninstall.plan({
        platform: input.platform,
        userDataRoot: input.userDataRoot,
        receipts,
      });

      for (const raw of planned) {
        const local = gateContributedUndo(applyKeepDataPreservation(raw, input.mode), input.undo);
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

        const composite = planStepId(maintainer.id, local, receipts);
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

        steps.push(toPlanStep(composite, local));
        bindings.set(composite, {
          maintainerId: maintainer.id,
          localStep: local,
          receipts,
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

/** Moves the receipt a step undoes through its undo lifecycle; absent when the step undoes none. */
const receiptLifecycle = (store: HostChangeReceiptStore | undefined, step: HostUninstallStep) => {
  const id = step.receiptId;
  if (store === undefined || id === undefined) return undefined;
  return {
    begin: store.write({ operation: "begin-undo", id }),
    settle: (outcome: HostUninstallOutcome) =>
      store
        .write(
          // A step that found the change already gone settles it too.
          outcome.outcome === "completed" || outcome.outcome === "skipped"
            ? { operation: "forget", id }
            : { operation: "undo-failed", id },
        )
        .pipe(Effect.ignore),
  };
};

export const executeHostUninstallContribution = (
  binding: ContributionBinding,
  input: {
    readonly platform: HostPlatform;
    readonly userDataRoot: string;
    /** Runs the step's declared change; absent when it declared none or no session exists. */
    readonly run?: HostChangeStepRunner;
    readonly receipts?: HostChangeReceiptStore;
  },
): Effect.Effect<HostUninstallOutcome> => {
  const { localStep, uninstall } = binding;
  return Effect.gen(function* () {
    const lifecycle = receiptLifecycle(input.receipts, localStep);
    if (lifecycle !== undefined) {
      const begun = yield* Effect.result(lifecycle.begin);
      if (begun._tag === "Failure") return { outcome: "failed" as const, error: begun.failure.message };
    }
    const exit = yield* Effect.exit(
      uninstall.execute({
        platform: input.platform,
        userDataRoot: input.userDataRoot,
        receipts: binding.receipts,
        step: localStep,
        ...(input.run === undefined ? {} : { run: input.run }),
      }),
    );
    const outcome = normalizeOutcome(exit);
    if (lifecycle !== undefined) yield* lifecycle.settle(outcome);
    return outcome;
  });
};

const normalizeOutcome = (exit: Exit.Exit<HostUninstallOutcome>): HostUninstallOutcome => {
  if (exit._tag === "Failure") {
    return { outcome: "failed", error: causeMessage(exit.cause) };
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
};

/** True when an originally-owned contribution must block user-data-root deletion.
 * SDK execute outcomes do not prove absence on non-completed results (including
 * skipped), so any non-completed outcome from an owned plan step preserves the root.
 */
export const contributionBlocksUserDataRoot = (
  plannedStatus: UninstallPlanStep["status"],
  outcome: UninstallStepOutcome,
): boolean => plannedStatus === "owned" && outcome !== "completed";
