import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const runbookPath = resolve(repoRoot, "docs/ci-runbook.md");

const requiredChecks = [
  "static-checks",
  "unit-tests-linux-x64",
  "schema-snapshot",
  "bundled-codegen",
  "library-api-tests",
  "recipe-tests",
  "guide-scenarios-darwin-arm64",
  "guide-scenarios-darwin-x64",
  "guide-scenarios-linux-arm64",
  "guide-scenarios-linux-x64",
  "guide-scenarios-windows-x64",
  "build-darwin-arm64",
  "build-darwin-x64",
  "build-linux-arm64",
  "build-linux-x64",
  "build-windows-x64",
  "perf-budget-linux-x64",
  "provider-integration-darwin-arm64",
  "provider-integration-darwin-x64",
  "provider-integration-linux-arm64",
  "provider-integration-linux-x64",
  "provider-integration-windows-x64",
] as const;

const extractBranchProtectionSection = (runbook: string): string => {
  const lines = runbook.split("\n");
  const start = lines.findIndex((line) => line === "## Branch protection");
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
};

const extractRequiredCheckList = (section: string): ReadonlyArray<string> =>
  section
    .split("\n")
    .map((line) => line.match(/^\s*- `([^`]+)`$/)?.[1])
    .filter((check): check is string => check !== undefined);

const extractWorkflowJobIds = (workflow: string): ReadonlyArray<string> => {
  const lines = workflow.split("\n");
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  expect(jobsStart).toBeGreaterThanOrEqual(0);

  return lines
    .slice(jobsStart + 1)
    .map((line) => line.match(/^ {2}([a-z0-9-]+):$/)?.[1])
    .filter((job): job is string => job !== undefined);
};

describe("branch protection", () => {
  test("documents the required CI status checks for merging to main", async () => {
    const runbook = await Bun.file(runbookPath).text();
    const branchProtection = extractBranchProtectionSection(runbook);
    const documentedChecks = extractRequiredCheckList(branchProtection);

    expect(branchProtection).toContain("main");
    expect(branchProtection).toContain("required status checks");
    expect(documentedChecks).toEqual([...requiredChecks]);

    for (const check of requiredChecks) {
      expect(branchProtection).toContain(check);
    }
  });

  test("keeps required status checks aligned with generated CI job ids", async () => {
    const runbook = await Bun.file(runbookPath).text();
    const workflow = await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text();
    const documentedChecks = extractRequiredCheckList(extractBranchProtectionSection(runbook));
    const workflowJobIds = extractWorkflowJobIds(workflow);

    expect(documentedChecks).toEqual([...requiredChecks]);

    for (const check of requiredChecks) {
      expect(workflowJobIds).toContain(check);
    }
  });
});
