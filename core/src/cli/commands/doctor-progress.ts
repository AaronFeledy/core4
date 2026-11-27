import { EventService } from "@lando/sdk/services";
import { type TaskTreeController, makeTaskTree } from "@lando/sdk/task-progress";
import { Effect, Option } from "effect";

import type { DoctorCheck, DoctorSectionId, DoctorSummary } from "./doctor-contract";

export const DOCTOR_TREE_ID = "doctor";

/** Live-tree row labels; report output keeps the section ids. */
export const DOCTOR_SECTION_LABELS = {
  "global-config": "Global config",
  provider: "Provider",
  "app-listeners": "App listeners",
  "database-credentials": "Database credentials",
  "certificate-authority": "Certificate authority",
  "network-trust": "Network trust",
  subsystems: "Subsystems",
  "global-app": "Global app",
  mcp: "MCP",
  "accelerated-starts": "Accelerated starts",
  "lando-roots": "Lando file ownership",
  "state-compatibility": "State compatibility",
  "missing-app-roots": "Missing app roots",
  "orphaned-volume-snapshots": "Orphaned volume snapshots",
  "legacy-snapshot-catalogs": "Legacy snapshot catalogs",
  "filesystem-watch": "Filesystem watch",
  "debugger-host": "Debugger host",
  "app-version-constraints": "App version constraints",
  deprecations: "Deprecations",
  "app-config": "App config",
} as const satisfies Record<DoctorSectionId, string>;

export interface DoctorSectionOutcome {
  readonly summary?: string;
  readonly warned?: boolean;
  readonly failed?: boolean;
  readonly skipped?: boolean;
  readonly remediation?: string;
}

type CheckLike = Pick<DoctorCheck, "status" | "solutions">;

const firstCommand = (checks: ReadonlyArray<CheckLike>): string | undefined => {
  for (const check of checks) {
    if (check.status === "pass") continue;
    for (const solution of check.solutions) {
      if (solution.command !== undefined && solution.command.length > 0) return solution.command;
    }
  }
  return undefined;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const checksOutcome = (
  id: DoctorSectionId,
  checks: ReadonlyArray<CheckLike>,
): DoctorSectionOutcome => {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (failed > 0) {
    const remediation = firstCommand(checks);
    return {
      summary: `${DOCTOR_SECTION_LABELS[id]} · ${plural(failed, "failure")}`,
      failed: true,
      ...(remediation === undefined ? {} : { remediation }),
    };
  }
  if (warned > 0)
    return { summary: `${DOCTOR_SECTION_LABELS[id]} · ${plural(warned, "warning")}`, warned: true };
  return {};
};

/**
 * Build the doctor tree against whichever `EventService` is in context. With
 * no event service (library callers, unit tests) every publish is a no-op.
 */
export const makeDoctorTree = (ids: ReadonlyArray<DoctorSectionId>): Effect.Effect<TaskTreeController> =>
  Effect.map(Effect.serviceOption(EventService), (events) =>
    makeTaskTree(Option.getOrUndefined(events), {
      parentId: DOCTOR_TREE_ID,
      label: "doctor",
      children: ids.map((id) => ({ id, label: DOCTOR_SECTION_LABELS[id] })),
      mode: "list",
    }),
  );

export const settleDoctorSection = (
  tree: TaskTreeController,
  id: DoctorSectionId,
  outcome: DoctorSectionOutcome,
): Effect.Effect<void> => {
  if (outcome.skipped === true)
    return tree.infoTask(id, outcome.summary ?? `${DOCTOR_SECTION_LABELS[id]} · skipped`);
  if (outcome.failed === true)
    return tree.failTask(
      id,
      outcome.summary,
      outcome.remediation === undefined ? {} : { remediation: outcome.remediation },
    );
  if (outcome.warned === true) return tree.warnTask(id, outcome.summary);
  return tree.completeTask(id, outcome.summary);
};

export const doctorTreeSummary = (counts: Pick<DoctorSummary, "failed" | "warned">): string => {
  if (counts.failed > 0) return `doctor · ${plural(counts.failed, "problem")} found`;
  if (counts.warned > 0) return `doctor · ${plural(counts.warned, "warning")}`;
  return "doctor · healthy";
};
