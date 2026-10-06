import { describe, expect, test } from "bun:test";

import type { DoctorSolution } from "../../src/cli/commands/doctor-contract";
import { doctorSolutionPayloads, sectionCheckEventPayload } from "../../src/cli/commands/doctor-ndjson";
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

describe("doctor section NDJSON payloads", () => {
  test("preserves solution key order when commands are optional", () => {
    // Given
    const input = solutions;
    // When
    const payloads = doctorSolutionPayloads(input);
    // Then
    expect(JSON.stringify(payloads)).toBe(
      '[{"kind":"manual","description":"Inspect configuration"},{"kind":"automatic","description":"Repair configuration","command":"lando doctor --fix"}]',
    );
  });

  test("orders known context keys before remaining insertion-ordered keys when building a section event", () => {
    // Given
    const check = {
      name: "global-app",
      status: "warn",
      severity: "warning",
      context: { zebra: "z", services: "router", alpha: "a", installed: "true" },
      solutions: [],
    };
    // When
    const payload = sectionCheckEventPayload(check, ["installed", "absent", "services"]);
    // Then
    expect(JSON.stringify(payload)).toBe(
      '{"_tag":"doctor.check","name":"global-app","status":"warn","severity":"warning","context":{"installed":"true","services":"router","zebra":"z","alpha":"a"},"solutions":[]}',
    );
  });
});
