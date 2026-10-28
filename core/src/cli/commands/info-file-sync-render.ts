import type { SummaryField, SummaryRow, SummarySection } from "@lando/renderer/summary";
import type { FileSyncInfo, FileSyncPolicyInfo, FileSyncPolicyReason } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "../diagnostic-text.ts";

const reasons = {
  "explicit-engine": "Selected in global config",
  "default-engine": "Selected automatically for this host",
  "sole-engine": "Only compatible installed engine",
  "native-provider": "Provider has native bind mounts",
  "global-passthrough": "Direct mounts selected in global config",
  "no-compatible-engine": "No compatible accelerator for this host and provider",
  "absent-app-mount": "No service mounts the project",
  "service-opt-out": "Acceleration disabled for the service",
  unknown: "Reason not recorded",
} satisfies Readonly<Record<FileSyncPolicyReason, string>>;

const shortList = (values: readonly string[]): string => {
  const shown = values.slice(0, 3).map(escapeDiagnosticText).join(", ");
  return values.length > 3 ? `${shown} (+${values.length - 3} more)` : shown || "none";
};

const modeLabel = (mode: FileSyncPolicyInfo["services"][number]["mode"], engineId?: string): string => {
  switch (mode) {
    case "ordinary":
      return "Direct mounts";
    case "accelerated":
      return engineId === undefined ? "Accelerated" : `Accelerated (${escapeDiagnosticText(engineId)})`;
    case "absent":
      return "No project mounts";
    case "unknown":
      return "Unknown";
    default:
      return mode satisfies never;
  }
};

const policyRow = (policy: FileSyncPolicyInfo, label: string): SummaryRow => {
  const fields: SummaryField[] = [];
  for (const service of policy.services) {
    if (service.mode === "absent") continue;
    const name = escapeDiagnosticText(service.service);
    if (service.mode !== policy.mode || service.reason !== policy.reason) {
      fields.push({
        label: `${name} files`,
        value: `${modeLabel(service.mode)}; ${reasons[service.reason]}`,
      });
    }
    switch (service.exclusions.kind) {
      case "transport-patterns":
        fields.push({
          label: `${name} exclusions`,
          value: `Transport filters: ${shortList(service.exclusions.patterns)}`,
        });
        break;
      case "directory-overlays":
        fields.push({ label: `${name} exclusions`, value: "Directory overlays; files are not filtered" });
        break;
      case "unknown":
        fields.push({ label: `${name} exclusions`, value: "Not verified" });
        break;
      case "none":
        break;
      default:
        service.exclusions.kind satisfies never;
    }
    if (service.hostBackedIncludes.length > 0) {
      fields.push({
        label: `${name} includes`,
        value: shortList(service.hostBackedIncludes.map(({ target }) => target)),
      });
    }
  }
  const value = modeLabel(policy.reason === "absent-app-mount" ? "absent" : policy.mode, policy.engineId);
  return { label, value, detail: reasons[policy.reason], fields };
};

export const fileSyncSection = (info: FileSyncInfo | undefined): SummarySection | undefined => {
  if (info === undefined || (info.applied === undefined && info.planned === undefined)) return undefined;
  const rows: SummaryRow[] = [];
  if (info.applied !== undefined) rows.push(policyRow(info.applied, "applied"));
  if (
    info.planned !== undefined &&
    (info.applied === undefined || info.pendingChange || info.applied.mode === "unknown")
  ) {
    rows.push(policyRow(info.planned, info.pendingChange ? "next start" : "planned"));
  }
  return {
    title: "project files",
    rows,
    ...(info.pendingChange
      ? { notes: ["Run `lando start` to apply the planned change safely."] }
      : info.applied !== undefined && info.planned === undefined
        ? {
            notes: [
              "Desired policy unavailable. Run `lando app:cache:refresh` to inspect desired configuration.",
            ],
          }
        : {}),
  };
};

export const plainFileSyncLines = (info: FileSyncInfo | undefined): readonly string[] => {
  const section = fileSyncSection(info);
  if (section === undefined) return [];
  return [
    ...section.rows.flatMap((row) => [
      `project-files\t${row.label}\t${row.value}\t${row.detail}`,
      ...(row.fields ?? []).map(({ label, value }) => `project-files\t${row.label}\t${label}\t${value}`),
    ]),
    ...(section.notes ?? []).map((note) => `project-files\tnote\t${note}`),
  ];
};
