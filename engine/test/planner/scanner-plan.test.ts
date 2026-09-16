import { describe, expect, test } from "bun:test";
import type { ScanPlan, ScannerConfig } from "@lando/sdk/schema";

describe("resolveScanPlan", () => {
  const defaults: ScanPlan = { enabled: true, path: "/", okCodes: [], retries: 2, timeoutMs: 20000 };
  const tuned: ScannerConfig = { path: "/ready", okCodes: [200, 302], retries: 5, timeout: 9000 };
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly global: ScannerConfig | undefined;
    readonly service: ScannerConfig | undefined;
    readonly expected: ScanPlan;
  }> = [
    {
      name: "uses defaults when both layers are absent",
      global: undefined,
      service: undefined,
      expected: defaults,
    },
    {
      name: "inherits global tuning when the service is absent",
      global: tuned,
      service: undefined,
      expected: { enabled: true, path: "/ready", okCodes: [200, 302], retries: 5, timeoutMs: 9000 },
    },
    {
      name: "overrides only named service fields",
      global: tuned,
      service: { path: "/service" },
      expected: { enabled: true, path: "/service", okCodes: [200, 302], retries: 5, timeoutMs: 9000 },
    },
    {
      name: "disables when global is false",
      global: false,
      service: undefined,
      expected: { ...defaults, enabled: false },
    },
    {
      name: "disables when service is false despite global tuning",
      global: tuned,
      service: false,
      expected: { enabled: false, path: "/ready", okCodes: [200, 302], retries: 5, timeoutMs: 9000 },
    },
    {
      name: "re-enables when a service object follows global false",
      global: false,
      service: { path: "/service" },
      expected: { ...defaults, path: "/service" },
    },
    {
      name: "preserves zero retries",
      global: tuned,
      service: { retries: 0 },
      expected: { enabled: true, path: "/ready", okCodes: [200, 302], retries: 0, timeoutMs: 9000 },
    },
  ];
  for (const scenario of cases) {
    test(scenario.name, async () => {
      // Given: a pair of scanner configuration layers.
      const { resolveScanPlan } = await import("../../src/planner/scanner-plan.ts");
      // When
      const result = resolveScanPlan(scenario.global, scenario.service);
      // Then
      expect(result).toEqual(scenario.expected);
    });
  }
});
