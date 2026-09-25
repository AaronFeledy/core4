/**
 * Live task-tree progress for `lando doctor`.
 *
 * Doctor publishes the same `task.tree.*` / `task.*` events `lando start`
 * does, one child per report section, so the default renderer paints the
 * familiar rail with a spinner while a section probes and a ✓/✗ once it
 * settles. Sections that pass with warnings settle as an amber `!` row
 * carrying the warning count; sections with a failing check, or that doctor itself could not run,
 * settle as ✗ with the first remediation command.
 */
import { Effect, Option } from "effect";

import type { ConfigLintResult } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { type TaskSpec, type TaskTreeController, makeTaskTree } from "@lando/sdk/task-progress";

import type { DoctorOptions } from "./doctor-options";
import type { DoctorDeprecationReport } from "./doctor-report-contract";
import type { DoctorSelfCheck } from "./doctor-self";

export const DOCTOR_TREE_ID = "doctor";

export type DoctorSectionId =
  | "provider"
  | "certificate-authority"
  | "network-trust"
  | "subsystems"
  | "global-app"
  | "mcp"
  | "app-version-constraints"
  | "deprecations"
  | "app-config";

/**
 * A row reads as its section id, like a service name under `lando start`:
 * `task.tree.start` carries only child ids, so the pending placeholder and
 * the running row would otherwise flip text when the section starts.
 */
export const doctorSectionLabel = (id: DoctorSectionId): string => id;

/** Sections in collection order, honoring the opt-in flags. */
export const doctorSections = (options: DoctorOptions): ReadonlyArray<TaskSpec> => {
  const ids: DoctorSectionId[] = [
    "provider",
    "certificate-authority",
    "network-trust",
    "subsystems",
    "global-app",
    "mcp",
  ];
  if (options.app === true) ids.push("app-version-constraints");
  if (options.deprecations === true) ids.push("deprecations");
  if (options.app === true) ids.push("app-config");
  return ids.map((id) => ({ id, label: doctorSectionLabel(id) }));
};

/** How a settled section reads in the tree: ✓ by default, ! when warned, ✗ when failed. */
export interface DoctorSectionOutcome {
  readonly summary?: string;
  readonly warned?: boolean;
  readonly failed?: boolean;
  readonly remediation?: string;
}

interface CheckLike {
  readonly status: "pass" | "warn" | "fail";
  readonly solutions: ReadonlyArray<{ readonly command?: string }>;
}

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
  const label = doctorSectionLabel(id);
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (failed > 0) {
    const remediation = firstCommand(checks);
    return {
      summary: `${label} · ${plural(failed, "failure")}`,
      failed: true,
      ...(remediation === undefined ? {} : { remediation }),
    };
  }
  if (warned > 0) return { summary: `${label} · ${plural(warned, "warning")}`, warned: true };
  return {};
};

export const certsOutcome = (status: {
  readonly _tag: string;
  readonly id?: string;
}): DoctorSectionOutcome => {
  const label = doctorSectionLabel("certificate-authority");
  return status._tag === "selected" && status.id !== undefined
    ? { summary: `${label} · ${status.id}` }
    : { summary: `${label} · ${status._tag}` };
};

export const deprecationsOutcome = (report: DoctorDeprecationReport): DoctorSectionOutcome => {
  const label = doctorSectionLabel("deprecations");
  const errors = report.entries.filter((entry) => entry.severity === "error").length;
  if (errors > 0) return { summary: `${label} · ${plural(errors, "error")}`, failed: true };
  if (report.entries.length > 0)
    return { summary: `${label} · ${plural(report.entries.length, "use")}`, warned: true };
  return { summary: `${label} · none` };
};

export const appConfigOutcome = (result: ConfigLintResult | undefined): DoctorSectionOutcome => {
  const label = doctorSectionLabel("app-config");
  if (result === undefined) return { summary: `${label} · skipped` };
  if (result.valid) return {};
  return { summary: `${label} · ${plural(result.violations.length, "violation")}`, failed: true };
};

export const selfCheckOutcome = (id: DoctorSectionId, self: DoctorSelfCheck): DoctorSectionOutcome => {
  const remediation = self.solutions.find((solution) => solution.command !== undefined)?.command;
  return {
    summary: `${doctorSectionLabel(id)} · ${self.reason}`,
    failed: true,
    ...(remediation === undefined ? {} : { remediation }),
  };
};

/**
 * Build the doctor tree against whichever `EventService` is in context. With
 * no event service (library callers, unit tests) every publish is a no-op.
 */
export const makeDoctorTree = (options: DoctorOptions): Effect.Effect<TaskTreeController> =>
  Effect.map(Effect.serviceOption(EventService), (events) =>
    makeTaskTree(Option.getOrUndefined(events), {
      parentId: DOCTOR_TREE_ID,
      label: "doctor",
      children: doctorSections(options),
      mode: "list",
    }),
  );

export const settleDoctorSection = (
  tree: TaskTreeController,
  id: DoctorSectionId,
  outcome: DoctorSectionOutcome,
): Effect.Effect<void> =>
  outcome.failed === true
    ? tree.failTask(
        id,
        outcome.summary,
        outcome.remediation === undefined ? {} : { remediation: outcome.remediation },
      )
    : outcome.warned === true
      ? tree.warnTask(id, outcome.summary)
      : tree.completeTask(id, outcome.summary);

export const doctorTreeSummary = (counts: {
  readonly failed: number;
  readonly warned: number;
}): string => {
  if (counts.failed > 0) return `doctor · ${plural(counts.failed, "problem")} found`;
  if (counts.warned > 0) return `doctor · ${plural(counts.warned, "warning")}`;
  return "doctor · healthy";
};
