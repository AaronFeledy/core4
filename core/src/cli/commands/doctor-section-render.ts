import type { DoctorSectionCheck } from "./doctor-contract";
import { renderSolution } from "./doctor-render-text";

export const renderSectionCheck = (
  check: DoctorSectionCheck,
  options: { readonly skipContextKeys?: ReadonlyArray<string> } = {},
): ReadonlyArray<string> => {
  const lines = [`${check.name}: ${check.status}`, `severity: ${check.severity}`];
  for (const [field, value] of Object.entries(check.context)) {
    if (options.skipContextKeys?.includes(field)) continue;
    lines.push(`${field}: ${value}`);
  }
  for (const solution of check.solutions) lines.push(renderSolution(solution));
  return lines;
};
