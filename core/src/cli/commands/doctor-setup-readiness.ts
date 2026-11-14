import type { DoctorFinding, DoctorStatus } from "./doctor-contract";
import { setupCommandForProvider } from "./doctor-provider";
import type { SetupReadinessSummary } from "./setup-readiness";

const setupReadinessStepContextKey = (id: string): string =>
  `step${id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("")}`;

export const buildSetupReadinessDoctorCheck = (summary: SetupReadinessSummary): DoctorFinding => {
  const failedStep = summary.steps.find((step) => step.status === "failed" || step.status === "unavailable");
  const status: DoctorStatus = summary.status === "ready" ? "pass" : "warn";
  const context: Record<string, string> = {
    setupProviderId: summary.providerId,
    setupStatus: summary.status,
    updatedAt: summary.updatedAt,
  };
  if (failedStep !== undefined) context.lastFailedStep = failedStep.id;
  for (const step of summary.steps) {
    context[setupReadinessStepContextKey(step.id)] = step.status;
    if (step.status === "failed" || step.status === "unavailable") {
      context[`${setupReadinessStepContextKey(step.id)}Evidence`] = step.evidence;
    }
  }
  const setupCommand = setupCommandForProvider(summary.providerId);
  // A run can fail before any step records evidence; it still needs a rerun hint.
  const remediation =
    summary.status === "in-progress"
      ? `Setup did not finish. Rerun \`${setupCommand}\` to complete host setup.`
      : (failedStep?.remediation ??
        (failedStep !== undefined || summary.status === "failed"
          ? `Rerun \`${setupCommand}\` to resume host setup.`
          : undefined));
  return {
    name: "setup-readiness",
    status,
    severity: status === "pass" ? "info" : "warn",
    context,
    solutions:
      remediation === undefined
        ? []
        : [{ kind: "manual" as const, description: remediation, command: setupCommand }],
  };
};
