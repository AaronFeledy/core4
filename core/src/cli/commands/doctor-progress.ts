import { EventService } from "@lando/sdk/services";
import { type TaskTreeController, makeTaskTree } from "@lando/sdk/task-progress";
import { Effect, Option } from "effect";

import type { DoctorCheck, DoctorSectionId, DoctorSummary } from "./doctor-contract";

export const DOCTOR_TREE_ID = "doctor";

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
      summary: `${id} · ${plural(failed, "failure")}`,
      failed: true,
      ...(remediation === undefined ? {} : { remediation }),
    };
  }
  if (warned > 0) return { summary: `${id} · ${plural(warned, "warning")}`, warned: true };
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
      // Pending placeholders use child ids, so keep running labels identical.
      children: ids.map((id) => ({ id, label: id })),
      mode: "list",
    }),
  );

export const settleDoctorSection = (
  tree: TaskTreeController,
  id: DoctorSectionId,
  outcome: DoctorSectionOutcome,
): Effect.Effect<void> => {
  if (outcome.skipped === true) return tree.infoTask(id, outcome.summary ?? `${id} · skipped`);
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
