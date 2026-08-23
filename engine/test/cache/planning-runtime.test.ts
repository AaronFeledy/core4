import { homedir, hostname } from "node:os";

import { expect, test } from "bun:test";

import {
  computePlanningRuntimeIdentity,
  computePlanningRuntimeParts,
  defaultPlanningRuntimeIdentity,
  fingerprintPlanningRuntimeParts,
} from "../../src/cache/planning-runtime.ts";

test("computes a stable non-secret planning runtime identity", () => {
  // Given
  const firstParts = computePlanningRuntimeParts();
  const first = computePlanningRuntimeIdentity();
  const probe = "LANDO_PLAN_CACHE_ENV_PROBE";
  const previous = process.env[probe];
  const hostName = hostname();
  const home = homedir();
  const execPath = process.execPath;

  // When
  process.env[probe] = "1";
  const second = computePlanningRuntimeIdentity();
  const secondParts = computePlanningRuntimeParts();
  if (previous === undefined) {
    delete process.env[probe];
  } else {
    process.env[probe] = previous;
  }
  const partsJson = JSON.stringify(secondParts);

  // Then
  expect(second).toBe(first);
  expect(partsJson).not.toContain(execPath);
  expect(home.length === 0 || !partsJson.includes(home)).toBe(true);
  expect(hostName.length === 0 || !partsJson.includes(hostName)).toBe(true);
  expect(firstParts.compiledExec).toBeUndefined();
  expect(secondParts.bundledSource).toMatch(/^[0-9a-f]{64}$/);
  expect(defaultPlanningRuntimeIdentity()).toBe(defaultPlanningRuntimeIdentity());
  expect(fingerprintPlanningRuntimeParts({ coreVersion: "0.0.0" })).not.toBe(
    fingerprintPlanningRuntimeParts({ coreVersion: "0.0.0", compiledExec: { size: 1, mtimeMs: 2 } }),
  );
});
