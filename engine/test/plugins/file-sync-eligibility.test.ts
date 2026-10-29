import { expect, test } from "bun:test";
import { Result } from "effect";
import { selectFileSyncCandidate } from "../../src/plugins/file-sync-selection.ts";

const engine = (id: string, platform: readonly ("linux" | "win32")[]) => ({
  id,
  pluginName: id,
  source: "explicit",
  supports: { platform },
  capabilities: {
    modes: ["two-way-safe" as const],
    exclusionPatterns: true,
    remoteAgentDeployment: "none" as const,
    conflictReporting: false,
    progressReporting: false,
  },
});
const policy = {
  platform: "linux",
  bindMountPerformance: "slow",
  fileSyncTargets: "prepared-volume",
} as const;

test("an eligible alternative wins over an unsupported default in either discovery order", () => {
  // Given
  const unsupported = {
    ...engine("windows", ["win32"]),
    defaultFor: { bindMountPerformance: ["slow" as const] },
  };
  const alternative = engine("linux", ["linux"]);
  for (const candidates of [
    [unsupported, alternative],
    [alternative, unsupported],
  ]) {
    // When
    const result = selectFileSyncCandidate(candidates, policy);
    // Then
    expect(Result.isSuccess(result) && result.success?.id).toBe("linux");
  }
});

test("automatic selection stays ordinary when no engine supports the host", () => {
  // Given / When
  const result = selectFileSyncCandidate([engine("windows", ["win32"])], policy);
  // Then
  expect(Result.isSuccess(result) && result.success).toBeUndefined();
});

test("explicit unsupported engine is rejected even on a native provider", () => {
  // Given / When
  const result = selectFileSyncCandidate([engine("windows", ["win32"])], {
    ...policy,
    bindMountPerformance: "native",
    defaultEngine: "windows",
  });
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test("automatic selection excludes engines that cannot honor exclusions", () => {
  // Given
  const unsupported = engine("unsafe", ["linux"]);
  // When
  const result = selectFileSyncCandidate(
    [{ ...unsupported, capabilities: { ...unsupported.capabilities, exclusionPatterns: false } }],
    policy,
  );
  // Then
  expect(Result.isSuccess(result) && result.success).toBeUndefined();
});

test("automatic selection stays ordinary without prepared-volume provider capability", () => {
  const result = selectFileSyncCandidate([engine("linux", ["linux"])], {
    ...policy,
    fileSyncTargets: undefined,
  });
  expect(Result.isSuccess(result) && result.success).toBeUndefined();
});

test("explicit selection fails without prepared-volume provider capability", () => {
  const result = selectFileSyncCandidate([engine("linux", ["linux"])], {
    ...policy,
    fileSyncTargets: undefined,
    defaultEngine: "linux",
  });
  expect(Result.isFailure(result)).toBe(true);
});
