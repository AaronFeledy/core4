import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const runbookPath = resolve(repoRoot, "docs/ci-runbook.md");

const requiredChecks = ["static-checks", "build-linux-x64", "provider-integration-linux-x64"] as const;

const extractBranchProtectionSection = (runbook: string): string => {
  const lines = runbook.split("\n");
  const start = lines.findIndex((line) => line === "## Branch protection");
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
};

describe("branch protection", () => {
  test("documents the required CI status checks for merging to main", async () => {
    const runbook = await Bun.file(runbookPath).text();
    const branchProtection = extractBranchProtectionSection(runbook);

    expect(branchProtection).toContain("main");
    expect(branchProtection).toContain("required status checks");

    for (const check of requiredChecks) {
      expect(branchProtection).toContain(check);
    }
  });
});
