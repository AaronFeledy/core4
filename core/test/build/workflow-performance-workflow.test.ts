import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { WORKFLOW_PERFORMANCE_CELLS } from "../../../scripts/workflow-performance-plan.ts";

const workflowPath = resolve(import.meta.dirname, "../../..", ".github/workflows/workflow-performance.yml");

describe("workflow performance workflow", () => {
  test("derives schedule/manual jobs from eligible readiness cells", async () => {
    const workflow = await Bun.file(workflowPath).text();
    expect(workflow).toContain("on:\n  schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("WORKFLOW_PERF_ISOLATION");
    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      expect(workflow).toContain(`workflow-performance-${cell.id}:`);
      expect(workflow).toContain(`runs-on: ${cell.runsOn}`);
    }
    expect(workflow.match(/^ {2}workflow-performance-.*:$/gm) ?? []).toHaveLength(
      WORKFLOW_PERFORMANCE_CELLS.length,
    );
  });

  test("retains reports and visible history without hiding correctness failures", async () => {
    const workflow = await Bun.file(workflowPath).text();
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("Render last-30-run trend");
    expect(workflow).toContain(
      "actions/workflows/workflow-performance.yml/runs?status=completed&per_page=30",
    );
    expect(workflow).not.toContain("gh api --paginate");
    expect(workflow).toContain("Enforce workflow correctness");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toContain("git push");
  });

  test("keeps setup, fixture preparation, and image pulls outside measured commands", async () => {
    const workflow = await Bun.file(workflowPath).text();
    expect(workflow).toContain("Assemble current-commit linux-x64 runtime bundle");
    expect(workflow).toContain("Assemble current-commit linux-arm64 runtime bundle");
    expect(workflow).toContain("build:host-proxy-shim");
    expect(workflow).toContain("build:log-file-helper");
    expect(workflow).toContain("core/dist/host-proxy");
    expect(workflow).toContain("core/dist/log-file-access");
    expect(workflow).toContain('--start-samples "$START_SAMPLES"');
    expect(workflow).toContain('--heavy-samples "$HEAVY_SAMPLES"');
    expect(workflow).not.toContain("podman system prune");
    expect(workflow).not.toContain("docker system prune");
  });
});
