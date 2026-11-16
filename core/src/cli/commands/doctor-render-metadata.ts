import type { SummarySection } from "@lando/renderer/summary";
import type { DoctorProvider, DoctorReport } from "./doctor-contract";

export const providerHeader = (provider: DoctorProvider | undefined): ReadonlyArray<string> => {
  if (provider === undefined) return [];
  const selection = provider.selection;
  return [
    `provider: ${provider.id}`,
    ...(provider.name === undefined ? [] : [`providerName: ${provider.name}`]),
    ...(provider.version === undefined ? [] : [`providerVersion: ${provider.version}`]),
    `providerKind: ${provider.kind}`,
    ...(provider.runtimeStatus === undefined ? [] : [`runtimeStatus: ${provider.runtimeStatus}`]),
    ...(provider.runtime?.version === undefined ? [] : [`runtimeVersion: ${provider.runtime.version}`]),
    `selectionSource: ${selection.source}`,
    ...Object.entries(selection.inputs).map(
      ([key, value]) =>
        `selectionInput${key === "capabilityDefault" ? "Default" : key[0]?.toUpperCase() + key.slice(1)}: ${value}`,
    ),
  ];
};

export const capabilitiesSection = (provider: DoctorProvider | undefined): SummarySection | undefined => {
  const capabilities = provider?.capabilities;
  if (capabilities === undefined || Object.keys(capabilities).length === 0) return undefined;
  return {
    title: "capabilities",
    rows: Object.entries(capabilities).map(([label, value]) => ({
      label,
      value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
    })),
  };
};

export const skippedSection = (report: DoctorReport): SummarySection | undefined =>
  report.skipped.length === 0
    ? undefined
    : {
        title: "skipped",
        rows: report.skipped.map((entry) => ({
          label: entry.check ?? entry.section,
          value: "SKIPPED",
          tone: "skipped",
          fields: [
            ...(entry.check === undefined ? [] : [{ label: "section", value: entry.section }]),
            { label: "reason", value: entry.reason },
          ],
        })),
      };
