import { GlobalAppError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import type { GlobalResolution } from "../global-app/resolution.ts";

export const dependencyError = (blockers: ReadonlyArray<string>): GlobalAppError =>
  new GlobalAppError({
    operation: "disable",
    message: `Global services still require the selected contribution: ${blockers.join(", ")}.`,
    remediation:
      "Select the dependent contributions as well, choose their owning plugin, or remove the authored dependency before disabling its service.",
  });

export const confirmedMissingGlobalService = (
  row: ServiceRuntimeInfo,
  plan: AppPlan,
  root: string,
): boolean =>
  row.app === plan.id &&
  row.appRoot === root &&
  plan.root === root &&
  row.providerId === plan.provider &&
  Object.values(plan.services).some((service) => service.name === row.service) &&
  row.containerId === undefined &&
  row.status === "stopped" &&
  row.state === "stopped" &&
  row.mounts?.status === "missing" &&
  row.publications?.status === "missing";

export const classifyGlobalCleanupInventory = (input: {
  readonly plan: AppPlan;
  readonly root: string;
  readonly observations: ReadonlyArray<ServiceRuntimeInfo>;
  readonly candidate: GlobalResolution;
  readonly selected: ReadonlySet<string>;
  readonly dependencyBlockers: (plan: AppPlan) => ReadonlyArray<string>;
}) => {
  const { plan, root, observations, candidate, selected } = input;
  const names = new Set(Object.values(plan.services).map((service) => String(service.name)));
  const active = new Set(
    observations
      .filter(
        (row) =>
          row.app === plan.id &&
          row.appRoot === root &&
          row.providerId === plan.provider &&
          row.containerId !== undefined &&
          ["running", "paused", "restarting"].includes(row.status),
      )
      .map((row) => String(row.service)),
  );
  const uncertain = (row: ServiceRuntimeInfo) =>
    row.app === plan.id &&
    (row.appRoot === undefined ||
      (row.appRoot === root &&
        (row.providerId !== plan.provider ||
          !names.has(String(row.service)) ||
          (row.containerId === undefined && !confirmedMissingGlobalService(row, plan, root)))));
  const uncertainSelected = observations.some((row) => selected.has(String(row.service)) && uncertain(row));
  const unknownObserved = observations.some(
    (row) =>
      !selected.has(String(row.service)) &&
      uncertain(row) &&
      ["running", "paused", "restarting"].includes(row.status),
  );
  const blockers = input.dependencyBlockers({
    ...plan,
    services: Object.fromEntries(Object.entries(plan.services).filter(([id]) => active.has(id))),
  });
  const unknownDependents = candidate.entries.some(
    (entry) =>
      entry.enabled &&
      !selected.has(entry.id) &&
      entry.dependencyEvidence === "unavailable" &&
      !names.has(entry.id) &&
      observations.some(
        (row) => String(row.service) === entry.id && (row.appRoot === root || row.appRoot === undefined),
      ),
  );
  const issue =
    uncertainSelected || unknownObserved
      ? "Runtime ownership or dependency evidence is incomplete; restore matching applied state before selected cleanup."
      : unknownDependents
        ? "Dependency evidence is unavailable for enabled contributions outside the applied plan; cleanup needs matching applied state."
        : blockers.length > 0
          ? "Applied dependents require an expanded selection before cleanup."
          : undefined;
  return { names, active, blockers, issue };
};
