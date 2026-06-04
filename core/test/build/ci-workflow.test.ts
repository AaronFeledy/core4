import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowsDir = resolve(repoRoot, ".github/workflows");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

const readWorkflow = async (): Promise<string> => Bun.file(workflowPath).text();

const findIndentedBlock = (source: string, key: string, indent = 0): string => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}${key}:`);
  expect(start).toBeGreaterThanOrEqual(0);

  const childIndent = indent + 2;
  const block: Array<string> = [];

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      block.push(line);
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < childIndent) break;
    block.push(line);
  }

  return block.join("\n");
};

describe("ci workflow", () => {
  test("keeps generated ci and release workflows as the only active workflows", async () => {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    const activeWorkflowFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    expect(activeWorkflowFiles).toEqual(["ci.yml", "nightly.yml", "release.yml"]);
  });

  test("runs static checks for pushes and pull requests to main", async () => {
    const workflow = await readWorkflow();
    const triggers = findIndentedBlock(workflow, "on");
    const jobs = findIndentedBlock(workflow, "jobs");
    const staticChecksPlatform = findIndentedBlock(jobs, "static-checks-platform", 2);
    const staticChecks = findIndentedBlock(jobs, "static-checks", 2);

    expect(triggers).toContain("  pull_request:");
    expect(triggers).toContain("    branches: [main]");
    expect(triggers).toContain("  push:");
    expect(staticChecksPlatform).toContain(
      "        platform: [darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64]",
    );
    expect(staticChecksPlatform).toContain("    runs-on: ${{ matrix.runs-on }}");
    expect(staticChecksPlatform).toContain("    timeout-minutes: 35");
    expect(staticChecksPlatform).toContain("        uses: oven-sh/setup-bun@v2");
    expect(staticChecksPlatform).toContain("          bun-version-file: .bun-version");
    expect(staticChecksPlatform).toContain("        run: bun install --frozen-lockfile");
    expect(staticChecksPlatform).toContain("        run: bun run typecheck");
    expect(staticChecksPlatform).toContain("        run: bun run lint");
    expect(staticChecksPlatform).toContain("        run: bun run test:unit");
    expect(staticChecksPlatform).toContain(
      "        run: bun test core/test/services core/test/cli core/test/scenario",
    );
    expect(staticChecksPlatform).toContain(
      "        run: bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts",
    );
    expect(staticChecksPlatform).toContain("        run: bun test core/test/library sdk/test/library");
    expect(staticChecksPlatform).toContain("::notice title=ci-timing::static-checks/${{ matrix.platform }}");
    expect(staticChecks).toContain("    needs: [static-checks-platform]");
    expect(staticChecks).toContain("    if: always()");
    expect(staticChecks).toContain(
      '          if [[ "${{ needs.static-checks-platform.result }}" != "success" ]]; then',
    );
    expect(staticChecks).toContain(
      '            echo "static-checks platform matrix result: ${{ needs.static-checks-platform.result }}"',
    );
    expect(staticChecks).toContain("            exit 1");
    expect(staticChecks).toContain('          echo "static-checks platform matrix passed"');
  });

  test("uses minimal read-only permissions for fork-safe pull requests", async () => {
    const workflow = await readWorkflow();
    const permissions = findIndentedBlock(workflow, "permissions");

    expect(permissions).toContain("  contents: read");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("contents: write");
  });

  test("builds and uploads the Linux x64 binary after static and codegen checks", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const buildLinux = findIndentedBlock(jobs, "build-linux-x64", 2);

    expect(buildLinux).toContain(
      "    needs: [static-checks, schema-snapshot, bundled-codegen, library-api-tests, recipe-tests]",
    );
    expect(buildLinux).toContain("    runs-on: ubuntu-24.04");
    expect(buildLinux).toContain("        run: bun run --filter='@lando/core' build:manifest");
    expect(buildLinux).toContain(
      "          bun build ./core/bin/lando.ts --compile --target=bun-linux-x64 --outfile ./dist/lando --sourcemap=external",
    );
    expect(buildLinux).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildLinux).toContain("          test -f dist/lando");
    expect(buildLinux).toContain("          ./dist/lando --version");
    expect(buildLinux).toContain("          ./dist/lando --help");
    expect(buildLinux).toContain("        uses: actions/upload-artifact@v4");
    expect(buildLinux).toContain("        if: always()");
    expect(buildLinux).toContain("          name: lando-linux-x64");
    expect(buildLinux).toContain("          path: dist/lando");
    expect(buildLinux).toContain("          if-no-files-found: ignore");
    expect(buildLinux).toContain("          retention-days: 7");

    expect(buildLinux.indexOf("./dist/lando --help")).toBeLessThan(
      buildLinux.indexOf("uses: actions/upload-artifact@v4"),
    );
  });

  test("runs library API and recipe test layers as branch-protectable jobs", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const libraryApiTests = findIndentedBlock(jobs, "library-api-tests", 2);
    const recipeTests = findIndentedBlock(jobs, "recipe-tests", 2);

    expect(libraryApiTests).toContain("    runs-on: ubuntu-24.04");
    expect(libraryApiTests).toContain("      - name: Run library API tests");
    expect(libraryApiTests).toContain("        run: bun test core/test/library sdk/test/library");

    expect(recipeTests).toContain("    runs-on: ubuntu-24.04");
    expect(recipeTests).toContain("      - name: Run recipe test layer");
    expect(recipeTests).toContain(
      "        run: bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts",
    );
  });

  test("runs generated guide scenarios as a branch-protectable Linux x64 gate", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const guideScenarios = findIndentedBlock(jobs, "guide-scenarios-linux-x64", 2);

    expect(guideScenarios).toContain("    needs: [static-checks]");
    expect(guideScenarios).toContain("    runs-on: ubuntu-24.04");
    expect(guideScenarios).toContain("        uses: oven-sh/setup-bun@v2");
    expect(guideScenarios).toContain("          bun-version-file: .bun-version");
    expect(guideScenarios).toContain("        run: bun install --frozen-lockfile");
    expect(guideScenarios).toContain("        run: bun run codegen");
    expect(guideScenarios).toContain("        run: bun run typecheck");
    expect(guideScenarios).toContain("        run: bun run lint:guides");
    expect(guideScenarios).toContain("        run: bun run check:guide-coverage");
    expect(guideScenarios).toContain("          fetch-depth: 0");
    expect(guideScenarios).toContain("      - name: Check guide drift");
    expect(guideScenarios).toContain("        if: ${{ github.event_name == 'pull_request' }}");
    expect(guideScenarios).toContain(
      "          GUIDE_DRIFT_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    );
    expect(guideScenarios).toContain(
      "          GUIDE_DRIFT_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(guideScenarios).toContain("          GUIDE_DRIFT_PR_BODY: ${{ github.event.pull_request.body }}");
    expect(guideScenarios).toContain("        run: bun run check:guide-drift");
    expect(guideScenarios).toContain("        run: bun test test/scenarios/generated/guides/**");
    expect(guideScenarios).toContain("        if: failure()");
    expect(guideScenarios).toContain("        uses: actions/upload-artifact@v4");
    expect(guideScenarios).toContain("          name: guide-scenario-transcripts-${{ github.run_id }}.zip");
    expect(guideScenarios).toContain("          path: dist/transcripts/guides/**/*.json");
    expect(guideScenarios).toContain("          if-no-files-found: ignore");
    expect(guideScenarios).toContain("          retention-days: 7");

    expect(guideScenarios.indexOf("bun install --frozen-lockfile")).toBeLessThan(
      guideScenarios.indexOf("bun run codegen"),
    );
    expect(guideScenarios.indexOf("bun run codegen")).toBeLessThan(
      guideScenarios.indexOf("bun run typecheck"),
    );
    expect(guideScenarios.indexOf("bun run typecheck")).toBeLessThan(
      guideScenarios.indexOf("bun run lint:guides"),
    );
    expect(guideScenarios.indexOf("bun run lint:guides")).toBeLessThan(
      guideScenarios.indexOf("bun run check:guide-coverage"),
    );
    expect(guideScenarios.indexOf("bun run check:guide-coverage")).toBeLessThan(
      guideScenarios.indexOf("bun run check:guide-drift"),
    );
    expect(guideScenarios.indexOf("bun run check:guide-drift")).toBeLessThan(
      guideScenarios.indexOf("bun test test/scenarios/generated/guides/**"),
    );
    expect(guideScenarios.indexOf("Upload guide scenario transcripts")).toBeGreaterThan(
      guideScenarios.indexOf("bun test test/scenarios/generated/guides/**"),
    );
  });

  test("runs the tooling hot-path perf budget as a branch-protectable Linux x64 gate", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const perfBudget = findIndentedBlock(jobs, "perf-budget-linux-x64", 2);

    expect(perfBudget).toContain("    needs: [build-linux-x64]");
    expect(perfBudget).toContain("    runs-on: ubuntu-24.04");
    expect(perfBudget).toContain("      - name: Download Linux x64 binary artifact");
    expect(perfBudget).toContain("          name: lando-linux-x64");
    expect(perfBudget).toContain("          path: dist");
    expect(perfBudget).toContain("      - name: Restore binary executable bit");
    expect(perfBudget).toContain("        run: chmod +x dist/lando");
    expect(perfBudget).toContain("      - name: Run tooling hot-path benchmark");
    expect(perfBudget).toContain("        run: bun run bench:tooling-hot-path -- --binary dist/lando");

    expect(perfBudget.indexOf("Download Linux x64 binary artifact")).toBeLessThan(
      perfBudget.indexOf("Restore binary executable bit"),
    );
    expect(perfBudget.indexOf("Restore binary executable bit")).toBeLessThan(
      perfBudget.indexOf("Run tooling hot-path benchmark"),
    );
  });

  test("runs provider integration tests against a private Podman socket", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const providerIntegration = findIndentedBlock(jobs, "provider-integration-linux-x64", 2);

    expect(providerIntegration).toContain("    needs: [build-linux-x64]");
    expect(providerIntegration).toContain("    runs-on: ubuntu-24.04");
    expect(providerIntegration).toContain("    timeout-minutes: 25");
    expect(providerIntegration).toContain("      - name: Run provider contract tests");
    expect(providerIntegration).toContain(
      "          bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-lando/test/contract.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-docker/test/contract.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-podman/test/contract.integration.test.ts",
    );
    expect(providerIntegration).toContain("      - name: Install Podman");
    expect(providerIntegration).toContain("          sudo apt-get install -y podman");
    expect(providerIntegration).toContain("      - name: Start Podman socket");
    expect(providerIntegration).toContain("          podman system service --time=0 unix:///tmp/podman.sock");
    expect(providerIntegration).toContain(
      '          echo "LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain(
      '          echo "LANDO_CONFIG__default_provider_id=lando" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain("      - name: Configure Docker socket");
    expect(providerIntegration).toContain("          test -S /var/run/docker.sock");
    expect(providerIntegration).toContain(
      '          echo "LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain("      - name: Restore binary executable bit");
    expect(providerIntegration).toContain("        run: chmod +x dist/lando");
    expect(providerIntegration).toContain("          sudo sysctl net.ipv4.ip_unprivileged_port_start=0");
    expect(providerIntegration).toContain(
      '          LANDO_MVP_BINARY_PATH="$GITHUB_WORKSPACE/dist/lando" bun test core/test/scenario',
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-lando/test/*.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-docker/test/*.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/service-lando/test/*.integration.test.ts",
    );
    expect(providerIntegration).not.toContain(
      "          bun test core/test/scenario/mvp-exit-criteria.scenario.test.ts",
    );
    expect(providerIntegration).toContain("      - name: Pre-pull container images");
    expect(providerIntegration).toContain("          podman pull node:lts");
    expect(providerIntegration).toContain("          podman pull node:22-alpine");
    expect(providerIntegration).toContain("          podman pull postgres:16");
    expect(providerIntegration).toContain("          podman pull postgres:16-alpine");
    expect(providerIntegration).toContain("          podman pull golang:1.22");
    expect(providerIntegration).toContain("          podman pull docker.io/library/alpine:3.21");
    expect(providerIntegration).toContain("          podman pull docker.io/axllent/mailpit:v1.30.1");
    expect(providerIntegration).toContain("          podman pull memcached:1.6");
    expect(providerIntegration).toContain("          docker pull node:22-alpine");
    expect(providerIntegration).toContain("      - name: Teardown Podman");
    expect(providerIntegration).toContain("        if: always()");
    expect(providerIntegration).toContain("      - name: Collect provider diagnostics");
    expect(providerIntegration).toContain("        if: failure()");
    expect(providerIntegration).toContain('          journalctl --no-pager --since "-30 minutes"');
    expect(providerIntegration).toContain("      - name: Upload provider integration diagnostics");
    expect(providerIntegration).toContain("        if: always()");
    expect(providerIntegration).toContain("        uses: actions/upload-artifact@v4");
    expect(providerIntegration).toContain("          name: provider-integration-diagnostics-linux-x64");
    expect(providerIntegration).toContain("          if-no-files-found: ignore");
    expect(providerIntegration).not.toContain("--silent");

    expect(providerIntegration.indexOf("Teardown Podman")).toBeGreaterThan(
      providerIntegration.indexOf("bun test plugins/provider-docker/test"),
    );
    expect(providerIntegration.indexOf("Upload provider integration diagnostics")).toBeGreaterThan(
      providerIntegration.indexOf("Collect provider diagnostics"),
    );
  });

  test("keeps Linux arm64 provider integration contract-only", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const providerIntegration = findIndentedBlock(jobs, "provider-integration-linux-arm64", 2);

    expect(providerIntegration).toContain("    needs: [build-linux-arm64]");
    expect(providerIntegration).toContain("    runs-on: ubuntu-24.04-arm");
    expect(providerIntegration).toContain("    timeout-minutes: 25");
    expect(providerIntegration).toContain("      - name: Run provider contract tests");
    expect(providerIntegration).toContain(
      "          bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-lando/test/contract.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-docker/test/contract.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-podman/test/contract.integration.test.ts",
    );
    expect(providerIntegration).toContain("      - name: Restore binary executable bit");
    expect(providerIntegration).toContain("        run: chmod +x dist/lando");
    expect(providerIntegration).toContain("      - name: Upload provider integration diagnostics");
    expect(providerIntegration).not.toContain("      - name: Install Podman");
    expect(providerIntegration).not.toContain("      - name: Start Podman socket");
    expect(providerIntegration).not.toContain("      - name: Configure Docker socket");
    expect(providerIntegration).not.toContain("      - name: Pre-pull container images");
    expect(providerIntegration).not.toContain("          docker pull node:22-alpine");
    expect(providerIntegration).not.toContain("      - name: Run provider integration tests");
    expect(providerIntegration).not.toContain(
      '          LANDO_MVP_BINARY_PATH="$GITHUB_WORKSPACE/dist/lando" bun test core/test/scenario',
    );
    expect(providerIntegration).not.toContain(
      "          bun test plugins/provider-lando/test/*.integration.test.ts",
    );
    expect(providerIntegration).not.toContain(
      "          bun test plugins/provider-docker/test/*.integration.test.ts",
    );
    expect(providerIntegration).not.toContain(
      "          bun test plugins/service-lando/test/*.integration.test.ts",
    );
  });

  test("generates the Beta multi-platform build and provider integration matrix", async () => {
    const workflow = await readWorkflow();

    for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]) {
      expect(workflow).toContain(`build-${platform}:`);
      expect(workflow).toContain(`provider-integration-${platform}:`);
      expect(workflow).toContain(`name: lando-${platform}`);
    }

    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("runs-on: macos-15-intel");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("--target=bun-windows-x64 --outfile ./dist/lando.exe");
    expect(workflow).toContain(
      "bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts",
    );
  });
});
