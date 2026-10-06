import { describe, expect, test } from "bun:test";

import type { DoctorSolution } from "../../src/cli/commands/doctor-contract";
import { renderSectionCheck } from "../../src/cli/commands/doctor-section-render";

const solutions: ReadonlyArray<DoctorSolution> = [
  { kind: "manual", description: "Inspect configuration" },
  { kind: "automatic", description: "Repair configuration", command: "lando doctor --fix" },
];

describe("renderSectionCheck", () => {
  test("renders context in insertion order before solutions when context is unsorted", () => {
    // Given
    const check = {
      name: "mcp",
      status: "warn",
      severity: "warning",
      context: { zebra: "last alphabetically", alpha: "first alphabetically" },
      solutions,
    };
    // When
    const lines = renderSectionCheck(check);
    // Then
    expect(lines).toEqual([
      "mcp: warn",
      "severity: warning",
      "zebra: last alphabetically",
      "alpha: first alphabetically",
      "solution[manual]: Inspect configuration",
      "solution[automatic]: Repair configuration (lando doctor --fix)",
    ]);
  });

  test("omits selected context keys when subsystem context is skipped", () => {
    // Given
    const check = {
      name: "router",
      status: "pass",
      severity: "info",
      context: { state: "running", subsystem: "proxy", ready: "true" },
      solutions: [],
    };
    // When
    const lines = renderSectionCheck(check, { skipContextKeys: ["subsystem"] });
    // Then
    expect(lines).toEqual(["router: pass", "severity: info", "state: running", "ready: true"]);
  });
});
