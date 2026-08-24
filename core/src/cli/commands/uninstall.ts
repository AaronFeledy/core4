import type {
  UninstallPlanStep,
  UninstallResult,
  UninstallStepStatus,
} from "@lando/engine/operations/uninstall";
import { type SummaryDocument, type SummaryTone, formatSummary } from "@lando/renderer/summary";
import { type RenderContext, summaryPaintOptions } from "../renderer-boundary";

const statusLabel = (status: UninstallStepStatus): string => {
  switch (status) {
    case "owned":
      return "owned by Lando";
    case "user-owned":
      return "user-owned";
    case "manual":
      return "manual remediation";
    case "skipped":
      return "skipped";
  }
};

const uninstallStepTone = (step: UninstallPlanStep): SummaryTone => {
  if (step.outcome === "failed") return "error";
  if (step.outcome === "completed") return "ok";
  if (step.status === "skipped") return "skipped";
  if (step.status === "manual" || step.status === "user-owned") return "warn";
  return "warn";
};

const uninstallSubtitle = (result: UninstallResult): string => {
  if (result.refused) return `refused · ${result.mode}`;
  if (result.dryRun) return `dry-run · ${result.mode}`;
  if (result.failed) return `incomplete · ${result.mode}`;
  return `complete · ${result.mode}`;
};

const uninstallNextSteps = (result: UninstallResult): ReadonlyArray<string> => {
  if (result.refused) return ["Rerun `lando uninstall --yes` after reviewing this plan."];
  if (result.dryRun) return ["No changes were made."];
  if (result.failed)
    return [
      `Partial failure report: ${result.reportPath ?? "unavailable"}. Rerun the same uninstall command after remediation.`,
    ];
  return ["Removed allowed Lando-owned uninstall targets."];
};

export const buildUninstallSummary = (result: UninstallResult): SummaryDocument => ({
  title: "UNINSTALL PLAN",
  tone: result.refused || result.failed ? "error" : result.dryRun ? "warn" : "ok",
  subtitle: uninstallSubtitle(result),
  sections: [
    {
      title: "targets",
      rows: result.steps.map((step) => {
        const outcome = step.outcome === undefined ? "" : ` [${step.outcome}]`;
        const detail = step.error === undefined ? step.detail : `${step.detail} Error: ${step.error}.`;
        return {
          label: step.label,
          tone: uninstallStepTone(step),
          value: `${statusLabel(step.status)}${outcome}`,
          detail,
          fields: [{ label: "target", value: step.target }],
        };
      }),
    },
  ],
  nextSteps: [...uninstallNextSteps(result)],
  footer: `${result.steps.length} targets · mode ${result.mode}`,
});

export const formatUninstallResult = (result: UninstallResult): string => {
  const heading = result.refused
    ? "uninstall refused: destructive execution requires --yes\nuninstall plan"
    : result.dryRun
      ? `uninstall plan (dry-run)\nmode: ${result.mode}`
      : result.failed
        ? `uninstall incomplete\nmode: ${result.mode}`
        : `uninstall complete\nmode: ${result.mode}`;
  const lines = result.steps.map((step) => {
    const action = step.destructive ? "destructive" : "non-destructive";
    const outcome = step.outcome === undefined ? "" : ` [${step.outcome}]`;
    const error = step.error === undefined ? "" : ` Error: ${step.error}.`;
    return `- ${step.label}: ${statusLabel(step.status)}${outcome} (${action}) — ${step.target}. ${step.detail}${error}`;
  });
  const trailer = result.refused
    ? ["Rerun `lando uninstall --yes` after reviewing this plan."]
    : result.dryRun
      ? ["No changes were made."]
      : result.failed
        ? [
            `Partial failure report: ${result.reportPath ?? "unavailable"}. Rerun the same uninstall command after remediation.`,
          ]
        : ["removed allowed Lando-owned uninstall targets."];
  return [heading, ...lines, ...trailer].join("\n");
};

export const renderUninstallResult = (
  result: UninstallResult,
  ctx?: RenderContext,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): string => {
  if (result.refused || result.failed) setExitCode(1);
  return ctx?.mode === "lando" && ctx.isTTY === true
    ? formatSummary(buildUninstallSummary(result), summaryPaintOptions(ctx))
    : formatUninstallResult(result);
};
