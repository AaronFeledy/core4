import type { DoctorCheck, DoctorResult, DoctorSelectionRecord, DoctorSolution } from "./doctor-contract";

const renderCapabilityValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

export const renderSolution = (solution: DoctorSolution): string => {
  const command = solution.command === undefined ? "" : ` (${solution.command})`;
  return `solution[${solution.kind}]: ${solution.description}${command}`;
};

const renderSelectionLines = (selection: DoctorSelectionRecord): ReadonlyArray<string> => {
  const lines = [`selectionSource: ${selection.source}`];
  const { inputs } = selection;
  if (inputs.flag !== undefined) lines.push(`selectionInputFlag: ${inputs.flag}`);
  if (inputs.landofile !== undefined) lines.push(`selectionInputLandofile: ${inputs.landofile}`);
  if (inputs.env !== undefined) lines.push(`selectionInputEnv: ${inputs.env}`);
  if (inputs.config !== undefined) lines.push(`selectionInputConfig: ${inputs.config}`);
  lines.push(`selectionInputDefault: ${inputs.capabilityDefault}`);
  return lines;
};

const renderCheck = (check: DoctorCheck): ReadonlyArray<string> => {
  const lines = [
    `${check.name}: ${check.status}`,
    `severity: ${check.severity}`,
    `provider: ${check.providerId}`,
    `providerName: ${check.providerName}`,
    `providerKind: ${check.providerKind}`,
    `providerVersion: ${check.providerVersion}`,
    `runtimeStatus: ${check.runtimeStatus}`,
  ];
  if (check.runtime.version !== undefined) lines.push(`runtimeVersion: ${check.runtime.version}`);
  if (check.runtime.oomKilled === true) lines.push("oomKilled: true");
  if (check.selection !== undefined) lines.push(...renderSelectionLines(check.selection));
  if (
    check.name === "setup-readiness" ||
    check.name === "runtime-service" ||
    check.name === "runtime-oom" ||
    check.name === "host-proxy-transport" ||
    check.name === "host-proxy-state" ||
    check.name === "host-proxy-allowlist"
  ) {
    for (const [field, value] of Object.entries(check.context)) {
      if (field === "providerId" || field === "providerKind" || field === "providerVersion") continue;
      lines.push(`${field}: ${value}`);
    }
  }
  for (const [field, value] of Object.entries(check.capabilities)) {
    lines.push(`${field}: ${renderCapabilityValue(value)}`);
  }
  for (const solution of check.solutions) lines.push(renderSolution(solution));
  return lines;
};

export const renderDoctorResult = (result: DoctorResult): string =>
  result.checks.flatMap((check) => renderCheck(check)).join("\n");
