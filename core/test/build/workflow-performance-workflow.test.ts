import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { WORKFLOW_PERFORMANCE_CELLS } from "../../../scripts/workflow-performance-plan.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(import.meta.dirname, "../../..", ".github/workflows/workflow-performance.yml");
const renderWorkflow = async (execution?: "enabled"): Promise<string> => {
  const call =
    execution === undefined
      ? "renderWorkflowPerformanceWorkflow()"
      : `renderWorkflowPerformanceWorkflow(${JSON.stringify(execution)})`;
  return Bun.$`bun -e ${`import { renderWorkflowPerformanceWorkflow } from "./scripts/build-workflow-performance-workflow.ts"; process.stdout.write(${call});`}`
    .cwd(repoRoot)
    .text();
};
const jobBody = (workflow: string, id: string): string => {
  const start = workflow.indexOf(`  workflow-performance-${id}:`);
  expect(start).toBeGreaterThan(-1);
  const next = workflow.indexOf("\n  workflow-performance-", start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
};
const commentOut = (block: string): string =>
  block
    .split("\n")
    .map((line) => (line.length === 0 ? "#" : `# ${line}`))
    .join("\n");

describe("enabled workflow performance rendering", () => {
  test("derives schedule/manual jobs from eligible readiness cells", async () => {
    const workflow = await renderWorkflow("enabled");
    expect(() => Bun.YAML.parse(workflow)).not.toThrow();
    expect(workflow).toContain("on:\n  schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
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
    const workflow = await renderWorkflow("enabled");
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
    const workflow = await renderWorkflow("enabled");
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

  test("authenticates every native cell immediately before sampling", async () => {
    const workflow = await renderWorkflow("enabled");

    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      const job = jobBody(workflow, cell.id);
      const prerequisites = job.indexOf("Provision rootless runtime prerequisites");
      const login = job.indexOf("Log in to Docker Hub");
      const samples = job.indexOf("Run workflow performance samples");

      expect(job).toContain("uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.4.0");
      expect(job).toContain("registry: docker.io");
      expect(job).toContain("username: ${{ secrets.DOCKERHUB_USERNAME }}");
      expect(job).toContain("password: ${{ secrets.DOCKERHUB_TOKEN }}");
      expect(job).toContain("logout: true");
      expect(job).toContain(`DOCKER_CONFIG: \${{ runner.temp }}/workflow-performance-${cell.id}-registry`);
      expect(job).toContain(
        `REGISTRY_AUTH_FILE: \${{ runner.temp }}/workflow-performance-${cell.id}-registry/config.json`,
      );
      expect(login).toBeGreaterThan(prerequisites);
      expect(samples).toBeGreaterThan(login);
    }
    expect(workflow.match(/secrets\.DOCKERHUB_/gu) ?? []).toHaveLength(WORKFLOW_PERFORMANCE_CELLS.length * 2);
  });

  test("keeps registry credentials outside uploaded artifacts and removes their directory", async () => {
    const workflow = await renderWorkflow("enabled");

    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      const job = jobBody(workflow, cell.id);
      const uploadStart = job.indexOf("Upload workflow performance report and trend");
      const enforceStart = job.indexOf("Enforce workflow correctness", uploadStart);
      const upload = job.slice(uploadStart, enforceStart);

      expect(upload).not.toContain(`workflow-performance-${cell.id}-registry`);
      expect(job).toContain(
        `rm -rf "$RUNNER_TEMP/workflow-performance-${cell.id}" "$RUNNER_TEMP/workflow-performance-${cell.id}-registry"`,
      );
    }
  });
});

describe("blocked committed workflow performance rendering", () => {
  test("matches the blocked generator output and parses with only the notice job live", async () => {
    const workflow = await Bun.file(workflowPath).text();
    const parsed = Bun.YAML.parse(workflow);
    const parsedJson = JSON.stringify(parsed);

    expect(workflow).toBe(await renderWorkflow());
    expect(parsedJson).toContain('"workflow-performance-blocked"');
    expect(parsedJson).not.toContain('"schedule"');
    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      expect(parsedJson).not.toContain(`workflow-performance-${cell.id}`);
    }
    expect(workflow.match(/^ {2}workflow-performance-.*:$/gmu) ?? []).toEqual([
      "  workflow-performance-blocked:",
    ]);
  });

  test("keeps the complete schedule and native jobs commented for credentialed re-enable", async () => {
    const blocked = await Bun.file(workflowPath).text();
    const enabled = await renderWorkflow("enabled");
    const enabledJobs = enabled.slice(enabled.indexOf("\njobs:\n") + "\njobs:\n".length);

    expect(blocked).toContain(commentOut("  schedule:\n    - cron: '0 4 * * *'"));
    expect(blocked).toContain(commentOut(enabledJobs));
    expect(blocked).toContain("WORKFLOW_PERFORMANCE_EXECUTION");
  });

  test("fails manual dispatch explicitly without running native setup or credentials", async () => {
    const workflow = await Bun.file(workflowPath).text();
    const liveWorkflow = workflow
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");

    expect(liveWorkflow).toContain("workflow_dispatch:");
    expect(liveWorkflow).toContain("workflow-performance-blocked:");
    expect(liveWorkflow).toContain("exit 1");
    expect(liveWorkflow).toContain("DOCKERHUB_USERNAME");
    expect(liveWorkflow).toContain("DOCKERHUB_TOKEN");
    expect(liveWorkflow).not.toContain("docker/login-action");
    expect(liveWorkflow).not.toContain("assemble-runtime-bundle");
    expect(liveWorkflow).not.toContain("Run workflow performance samples");
  });
});
