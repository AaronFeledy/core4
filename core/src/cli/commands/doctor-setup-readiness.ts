import type { DoctorCheck, DoctorSelectionRecord, DoctorStatus } from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";
import type { SetupReadinessSummary } from "./setup-readiness";

const setupReadinessStepContextKey = (id: string): string =>
  `step${id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("")}`;

export const buildSetupReadinessDoctorCheck = (
  summary: SetupReadinessSummary,
  provider: { readonly id: string; readonly displayName: string; readonly version: string },
  selection?: DoctorSelectionRecord,
): DoctorCheck => {
  const failedStep = summary.steps.find((step) => step.status === "failed" || step.status === "unavailable");
  const status: DoctorStatus = summary.status === "ready" ? "pass" : "warn";
  const context: Record<string, string> = {
    providerId: provider.id,
    providerKind: providerKindFor(provider.id),
    providerVersion: provider.version,
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
  return {
    name: "setup-readiness",
    status,
    severity: status === "pass" ? "info" : "warn",
    providerId: provider.id,
    providerName: provider.displayName,
    providerVersion: provider.version,
    providerKind: providerKindFor(provider.id),
    runtimeStatus: summary.status,
    runtime: { running: summary.status === "ready", message: summary.status },
    capabilities: {},
    context,
    solutions:
      failedStep === undefined
        ? []
        : [
            {
              kind: "manual" as const,
              description: failedStep.remediation ?? "Rerun `lando setup` to resume host setup.",
              command: "lando setup",
            },
          ],
    ...(selection === undefined ? {} : { selection }),
  };
};
