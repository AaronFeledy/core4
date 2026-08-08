import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderReleaseWorkflow } from "../../../scripts/build-release-workflow.ts";
import { releasePackageNames } from "../../../scripts/prepare-npm-dev-packages.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

/** Extract a top-level GitHub Actions job block (`  job-id:`) through the next sibling job. */
const jobBlock = (workflow: string, jobId: string): string => {
  const marker = `  ${jobId}:`;
  const start = workflow.indexOf(marker);
  if (start < 0) {
    throw new Error(`release workflow job "${jobId}" not found`);
  }
  const fromJob = workflow.slice(start);
  const nextJob = fromJob.match(/\n {2}[A-Za-z0-9_-]+:/u);
  if (nextJob?.index === undefined) return fromJob;
  return fromJob.slice(0, nextJob.index);
};

describe("release workflow", () => {
  test("keeps npm publish in npm-alpha-packages without registry smoke", async () => {
    // Given
    const workflow = renderReleaseWorkflow();
    const packages = jobBlock(workflow, "npm-alpha-packages");

    // Then: publish stays here; smoke must not share the credentialed job
    expect(packages).toContain("- name: Publish npm dev packages");
    expect(packages).not.toContain("- name: Smoke-test published npm packages");
    expect(packages).not.toContain('SMOKE_ROOT="$RUNNER_TEMP/lando-npm-smoke"');
    expect(packages).not.toContain('npm view "$package_spec" version');
    expect(packages).not.toContain("makeLandoRuntime");
    expect(packages).not.toContain("openLandoRuntime");
  });

  test("smoke-tests the published core package in a separate credential-free npm-alpha-smoke job", async () => {
    // Given
    const workflow = renderReleaseWorkflow();
    const bunVersion = (await Bun.file(resolve(repoRoot, ".bun-version")).text()).trim();
    const packagesStart = workflow.indexOf("  npm-alpha-packages:");
    const smokeStart = workflow.indexOf("  npm-alpha-smoke:");
    expect(packagesStart).toBeGreaterThanOrEqual(0);
    expect(smokeStart).toBeGreaterThan(packagesStart);

    const smoke = jobBlock(workflow, "npm-alpha-smoke");
    const expectedReadinessLoop = `for package_spec in ${releasePackageNames
      .map((name) => `"${name}@$LANDO_NPM_VERSION"`)
      .join(" ")}; do`;

    // Then: separate job ordering + least privilege
    expect(smoke).toContain("needs: [npm-alpha-packages]");
    expect(smoke).toContain("if: github.event.workflow_run.conclusion == 'success'");
    expect(smoke).toContain("permissions: {}");
    expect(smoke).not.toContain("id-token");
    expect(smoke).not.toContain("contents:");
    expect(smoke).not.toContain("actions:");
    expect(smoke).not.toContain("GH_TOKEN");
    expect(smoke).not.toContain("NODE_AUTH_TOKEN");
    expect(smoke).not.toContain("NPM_TOKEN");
    expect(smoke).not.toContain("registry-url");
    expect(smoke).not.toContain("checkout");
    expect(smoke).not.toContain("bun-version-file");
    expect(smoke).toContain("node-version: 22");
    expect(smoke).toContain(`bun-version: ${bunVersion}`);

    // Then: exact-version loop awaits every canonical release package, then install / seam / root-import smoke
    expect(smoke).toContain("- name: Smoke-test published npm packages");
    expect(smoke).toContain("LANDO_NPM_VERSION: 4.0.0-alpha.${{ github.run_number }}");
    expect(smoke).toContain('SMOKE_ROOT="$RUNNER_TEMP/lando-npm-smoke"');
    expect(smoke).toContain(expectedReadinessLoop);
    expect(smoke).toContain('npm view "$package_spec" version');
    expect(smoke).toContain(
      'npm install --ignore-scripts --no-audit --no-fund "@lando/core@$LANDO_NPM_VERSION"',
    );
    expect(smoke).toContain('Bun.resolveSync("@lando/engine", process.env.SMOKE_ROOT)');
    expect(smoke).toContain('Bun.resolveSync("@lando/landofile", process.env.SMOKE_ROOT)');
    expect(smoke).toContain('await import("@lando/core/testing")');
    expect(smoke).toContain(
      'npm install --ignore-scripts --no-audit --no-fund "@lando/provider-lando@$LANDO_NPM_VERSION"',
    );
    expect(smoke).toContain('await import("@lando/core")');
    expect(smoke).toContain("makeLandoRuntime");
    expect(smoke).toContain("openLandoRuntime");
  });
});
