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

    expect(activeWorkflowFiles).toEqual(["ci.yml", "release.yml"]);
  });

  test("runs static checks for pushes and pull requests to main", async () => {
    const workflow = await readWorkflow();
    const triggers = findIndentedBlock(workflow, "on");
    const jobs = findIndentedBlock(workflow, "jobs");
    const staticChecks = findIndentedBlock(jobs, "static-checks", 2);

    expect(triggers).toContain("  pull_request:");
    expect(triggers).toContain("    branches: [main]");
    expect(triggers).toContain("  push:");
    expect(staticChecks).toContain("    runs-on: ubuntu-22.04");
    expect(staticChecks).toContain("        uses: oven-sh/setup-bun@v2");
    expect(staticChecks).toContain("          bun-version-file: .bun-version");
    expect(staticChecks).toContain("        run: bun install --frozen-lockfile");
    expect(staticChecks).toContain("        run: bun run typecheck");
    expect(staticChecks).toContain("        run: bun run lint");
    expect(staticChecks).toContain("        run: bun run test:unit");
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
    expect(buildLinux).toContain("    runs-on: ubuntu-22.04");
    expect(buildLinux).toContain("        run: bun run build");
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

    expect(libraryApiTests).toContain("    runs-on: ubuntu-22.04");
    expect(libraryApiTests).toContain("      - name: Run library API tests");
    expect(libraryApiTests).toContain("        run: bun test core/test/library sdk/test/library");

    expect(recipeTests).toContain("    runs-on: ubuntu-22.04");
    expect(recipeTests).toContain("      - name: Run recipe test layer");
    expect(recipeTests).toContain(
      "        run: bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts",
    );
  });

  test("runs provider integration tests against a private Podman socket", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const providerIntegration = findIndentedBlock(jobs, "provider-integration-linux-x64", 2);

    expect(providerIntegration).toContain("    needs: [build-linux-x64]");
    expect(providerIntegration).toContain("    runs-on: ubuntu-22.04");
    expect(providerIntegration).toContain("    timeout-minutes: 20");
    expect(providerIntegration).toContain("      - name: Install Podman");
    expect(providerIntegration).toContain("          sudo apt-get install -y podman");
    expect(providerIntegration).toContain("      - name: Start Podman socket");
    expect(providerIntegration).toContain("          podman system service --time=0 unix:///tmp/podman.sock");
    expect(providerIntegration).toContain(
      '          echo "LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain(
      '          echo "LANDO_DEFAULT_PROVIDER_ID=lando" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain("      - name: Configure Docker socket");
    expect(providerIntegration).toContain("          test -S /var/run/docker.sock");
    expect(providerIntegration).toContain(
      '          echo "LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain("      - name: Restore binary executable bit");
    expect(providerIntegration).toContain("        run: chmod +x dist/lando");
    expect(providerIntegration).toContain(
      '          LANDO_MVP_BINARY_PATH="$GITHUB_WORKSPACE/dist/lando" bun test core/test/scenario',
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-lando/test --filter=integration",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-docker/test --filter=integration",
    );
    expect(providerIntegration).not.toContain(
      "          bun test core/test/scenario/mvp-exit-criteria.scenario.test.ts",
    );
    expect(providerIntegration).toContain("      - name: Pre-pull container images");
    expect(providerIntegration).toContain("          podman pull node:lts");
    expect(providerIntegration).toContain("          podman pull node:22-alpine");
    expect(providerIntegration).toContain("          podman pull postgres:16");
    expect(providerIntegration).toContain("          podman pull postgres:16-alpine");
    expect(providerIntegration).toContain("          docker pull node:22-alpine");
    expect(providerIntegration).toContain("      - name: Teardown Podman");
    expect(providerIntegration).toContain("        if: always()");
    expect(providerIntegration).toContain("      - name: Collect provider diagnostics");
    expect(providerIntegration).toContain("        if: failure()");
    expect(providerIntegration).toContain('          journalctl --no-pager --since "-30 minutes"');
    expect(providerIntegration).toContain("      - name: Upload provider integration diagnostics");
    expect(providerIntegration).toContain("        if: always()");
    expect(providerIntegration).toContain("        uses: actions/upload-artifact@v4");
    expect(providerIntegration).toContain("          name: provider-integration-diagnostics");
    expect(providerIntegration).toContain("          if-no-files-found: ignore");
    expect(providerIntegration).not.toContain("--silent");

    expect(providerIntegration.indexOf("Teardown Podman")).toBeGreaterThan(
      providerIntegration.indexOf("bun test plugins/provider-docker/test"),
    );
    expect(providerIntegration.indexOf("Upload provider integration diagnostics")).toBeGreaterThan(
      providerIntegration.indexOf("Collect provider diagnostics"),
    );
  });

  test("keeps broad multi-platform and default macOS provider validation out of Alpha CI", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("build-linux-x64:");
    expect(workflow).toContain("provider-integration-linux-x64:");

    expect(workflow).not.toContain("strategy:");
    expect(workflow).not.toContain("matrix:");
    expect(workflow).not.toContain("windows-");
    expect(workflow).not.toContain("windows-latest");
    expect(workflow).not.toContain("windows-2022");
    expect(workflow).not.toContain("linux-arm64");
    expect(workflow).not.toContain("ubuntu-latest-arm64");
    expect(workflow).not.toContain("darwin-");

    if (workflow.includes("runs-on: macos-")) {
      expect(workflow).toContain("LANDO_TEST_PROVIDER_LANDO_MACOS");
    }
  });
});
