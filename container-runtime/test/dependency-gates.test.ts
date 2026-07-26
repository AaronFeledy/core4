import { describe, expect, test } from "bun:test";

import { GATE_CONDITIONS, gateId, gateNodeId, parseGateId } from "../src/dependency-gates.ts";

describe("gateId", () => {
  test("maps each depends_on condition to its stable gate id", () => {
    // Given / When / Then
    expect(gateId("db", "service_started")).toBe("db:running");
    expect(gateId("db", "service_healthy")).toBe("db:healthy");
    expect(gateId("db", "service_completed_successfully")).toBe("db:completed");
  });

  test("covers every declared condition exactly once", () => {
    // Given
    const ids = GATE_CONDITIONS.map((condition) => gateId("db", condition));

    // Then
    expect(GATE_CONDITIONS).toEqual(["service_started", "service_healthy", "service_completed_successfully"]);
    expect(new Set(ids).size).toBe(GATE_CONDITIONS.length);
  });
});

test("gate node ids are disjoint from user-facing gate labels", () => {
  // Given / When / Then
  expect(gateNodeId("db", "service_healthy")).toBe("gate:db:healthy");
  expect(gateNodeId("db", "service_healthy")).not.toBe(gateId("db", "service_healthy"));
});

describe("parseGateId", () => {
  test("round-trips every gate id back to its service and condition", () => {
    // Given / When / Then
    for (const condition of GATE_CONDITIONS) {
      expect(parseGateId(gateId("db", condition))).toEqual({ service: "db", condition });
    }
  });

  test("rejects ids that are not gates", () => {
    // Given / When / Then
    expect(parseGateId("web:app:install")).toBeUndefined();
    expect(parseGateId("web:app:running")).toBeUndefined();
    expect(parseGateId("running")).toBeUndefined();
    expect(parseGateId(":running")).toBeUndefined();
    expect(parseGateId("db:started")).toBeUndefined();
  });
});
