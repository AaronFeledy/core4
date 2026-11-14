import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { WORKFLOW_PERFORMANCE_CELLS } from "../../../scripts/workflow-performance-plan.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(import.meta.dirname, "../../..", ".github/workflows/workflow-performance.yml");
const renderWorkflow = async (): Promise<string> =>
  Bun.$`bun -e ${'import { renderWorkflowPerformanceWorkflow } from "./scripts/build-workflow-performance-workflow.ts"; process.stdout.write(renderWorkflowPerformanceWorkflow());'}`
    .cwd(repoRoot)
    .text();
const jobBody = (workflow: string, id: string): string => {
  const start = workflow.indexOf(`  workflow-performance-${id}:`);
  expect(start).toBeGreaterThan(-1);
  const next = workflow.indexOf("\n  workflow-performance-", start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
};
describe("workflow performance rendering", () => {
  test("derives schedule/manual jobs from eligible readiness cells", async () => {
    const workflow = await renderWorkflow();
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
    const workflow = await renderWorkflow();
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
    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      const ran = "always() && steps.performance.outcome != 'skipped'";
      expect(Bun.YAML.parse(workflow)).toMatchObject({
        jobs: {
          [`workflow-performance-${cell.id}`]: {
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "Render last-30-run trend", if: ran }),
              expect.objectContaining({ name: "Upload workflow performance report and trend", if: ran }),
              expect.objectContaining({ name: "Enforce workflow correctness", if: "always()" }),
            ]),
          },
        },
      });
    }
    expect(workflow).not.toContain("git push");
  });

  test("keeps setup, fixture preparation, and image pulls outside measured commands", async () => {
    const workflow = await renderWorkflow();
    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      const label = cell.bundleKey.replace("linux-", "Linux ");
      expect(Bun.YAML.parse(workflow)).toMatchObject({
        jobs: {
          [`workflow-performance-${cell.id}`]: {
            steps: expect.arrayContaining([
              expect.objectContaining({
                name: `Restore assembled ${label} runtime bundle`,
                id: "runtime-bundle-cache",
                with: {
                  path: `dist/cache/runtime-bundle/lando-runtime-${cell.bundleKey}.tar.gz`,
                  key: "${{ steps.runtime-bundle-key.outputs.key }}",
                },
              }),
              expect.objectContaining({
                name: `Assemble current-commit ${label} runtime bundle`,
                if: "steps.runtime-bundle-cache.outputs.cache-hit != 'true'",
              }),
            ]),
          },
        },
      });
    }
    expect(workflow).not.toContain("build:host-proxy-shim");
    expect(workflow).not.toContain("build:log-file-helper");
    expect(workflow).not.toContain("core/dist/host-proxy");
    expect(workflow).not.toContain("core/dist/log-file-access");
    expect(workflow).toContain("scripts/build-compiled-binary.ts");
    expect(workflow).toContain('--start-samples "$START_SAMPLES"');
    expect(workflow).toContain('--heavy-samples "$HEAVY_SAMPLES"');
    expect(workflow).not.toContain("podman system prune");
    expect(workflow).not.toContain("docker system prune");
  });

  test("logs in to Docker Hub only when both secrets exist and otherwise pulls anonymously", async () => {
    const workflow = await renderWorkflow();
    const parsed: unknown = Bun.YAML.parse(workflow);

    for (const cell of WORKFLOW_PERFORMANCE_CELLS) {
      const job = jobBody(workflow, cell.id);
      const prerequisites = job.indexOf("Provision rootless runtime prerequisites");
      const login = job.indexOf("Log in to Docker Hub");
      const samples = job.indexOf("Run workflow performance samples");
      const authFile = `"$RUNNER_TEMP/workflow-performance-${cell.id}-registry/config.json"`;

      expect(parsed).toMatchObject({
        jobs: {
          [`workflow-performance-${cell.id}`]: {
            env: {
              WORKFLOW_PERF_DOCKER_HUB_LOGIN:
                "${{ secrets.DOCKERHUB_USERNAME != '' && secrets.DOCKERHUB_TOKEN != '' }}",
            },
            steps: expect.arrayContaining([
              expect.objectContaining({
                name: "Log in to Docker Hub",
                if: "env.WORKFLOW_PERF_DOCKER_HUB_LOGIN == 'true'",
                uses: "docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550",
                env: { DOCKER_CONFIG: `\${{ runner.temp }}/workflow-performance-${cell.id}-registry` },
                with: {
                  registry: "docker.io",
                  username: "${{ secrets.DOCKERHUB_USERNAME }}",
                  password: "${{ secrets.DOCKERHUB_TOKEN }}",
                  logout: true,
                },
              }),
              expect.objectContaining({
                name: "Run workflow performance samples",
                run: expect.stringContaining(
                  `if [ "$WORKFLOW_PERF_DOCKER_HUB_LOGIN" = true ]; then\n  export REGISTRY_AUTH_FILE=${authFile}\nelse\n  echo "::notice title=Docker Hub::Pulling anonymously.`,
                ),
              }),
            ]),
          },
        },
      });
      expect(job).not.toContain("REGISTRY_AUTH_FILE:");
      expect(login).toBeGreaterThan(prerequisites);
      expect(samples).toBeGreaterThan(login);
    }
    expect(workflow.match(/secrets\.DOCKERHUB_/gu) ?? []).toHaveLength(WORKFLOW_PERFORMANCE_CELLS.length * 4);
  });

  test("keeps registry credentials outside uploaded artifacts and removes their directory", async () => {
    const workflow = await renderWorkflow();

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

describe("committed workflow performance workflow", () => {
  test("is the generator output", async () => {
    expect(await Bun.file(workflowPath).text()).toBe(await renderWorkflow());
  });
});
