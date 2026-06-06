import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scenarioSmokePath = resolve(repoRoot, "core/test/scenario/mvp-exit-criteria.scenario.test.ts");
const workflowsDir = resolve(repoRoot, ".github/workflows");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");
const nightlyWorkflowPath = resolve(repoRoot, ".github/workflows/nightly.yml");
const providerMatrixWorkflowPath = resolve(repoRoot, ".github/workflows/provider-matrix.yml");

const readWorkflow = async (): Promise<string> => Bun.file(workflowPath).text();
const readNightlyWorkflow = async (): Promise<string> => Bun.file(nightlyWorkflowPath).text();
const readProviderMatrixWorkflow = async (): Promise<string> => Bun.file(providerMatrixWorkflowPath).text();

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
  test("keeps generated workflows as the only active workflows", async () => {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    const activeWorkflowFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    expect(activeWorkflowFiles).toEqual(["ci.yml", "nightly.yml", "provider-matrix.yml", "release.yml"]);
  });

  test("runs the weekly provider matrix as an advisory workflow", async () => {
    const workflow = await readProviderMatrixWorkflow();
    const triggers = findIndentedBlock(workflow, "on");
    const permissions = findIndentedBlock(workflow, "permissions");
    const jobs = findIndentedBlock(workflow, "jobs");
    const providerContracts = findIndentedBlock(jobs, "provider-contracts", 2);

    expect(workflow).toContain("name: provider-matrix");
    expect(triggers).toContain("  schedule:");
    expect(triggers).toContain("    - cron: '0 8 * * 1'");
    expect(triggers).toContain("  workflow_dispatch:");
    expect(permissions).toContain("  contents: read");
    expect(providerContracts).toContain("      fail-fast: false");
    expect(providerContracts).toContain("            engine: Docker Desktop");
    expect(providerContracts).toContain("            engine: Docker Engine");
    expect(providerContracts).toContain("            engine: Podman Desktop");
    expect(providerContracts).toContain("            engine: Podman");
    expect(providerContracts).toContain("            engine: Lima");
    expect(providerContracts).toContain("            engine: OrbStack");
    expect(providerContracts).toContain("      - name: Notice unsupported hosted runner cell");
    expect(providerContracts).toContain("        if: ${{ matrix.installable == false }}");
    expect(providerContracts).toContain("      - name: Setup Bun");
    expect(providerContracts).toContain("          bun-version-file: .bun-version");
    expect(providerContracts).toContain("        run: bun install --frozen-lockfile");
    expect(providerContracts).toContain("      - name: Install Podman");
    expect(providerContracts).toContain("      - name: Configure Docker socket");
    expect(providerContracts).toContain("      - name: Run provider contract tests");
    expect(providerContracts).toContain(
      "          bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts",
    );
    expect(providerContracts).toContain(
      "          bun test plugins/provider-lando/test/contract.integration.test.ts",
    );
    expect(providerContracts).toContain(
      "          bun test plugins/provider-docker/test/contract.integration.test.ts",
    );
    expect(providerContracts).toContain(
      "          bun test plugins/provider-podman/test/contract.integration.test.ts",
    );
    expect(providerContracts).toContain("      - name: Collect provider matrix diagnostics");
    expect(providerContracts).toContain("      - name: Upload provider matrix diagnostics");
    expect(providerContracts).toContain("          name: provider-matrix-diagnostics-${{ matrix.cell }}");
  });

  test("runs nightly provider-lando e2e on Linux x64", async () => {
    const workflow = await readNightlyWorkflow();
    const smokeScenario = await Bun.file(scenarioSmokePath).text();
    const jobs = findIndentedBlock(workflow, "jobs");
    const providerLandoE2e = findIndentedBlock(jobs, "provider-lando-e2e-linux-x64", 2);

    expect(smokeScenario).toContain('test("@smoke reproduces the full init/start/info/stop flow');
    expect(workflow).toContain("name: nightly");
    expect(providerLandoE2e).toContain("    runs-on: ubuntu-24.04");
    expect(providerLandoE2e).toContain("    timeout-minutes: 60");
    expect(providerLandoE2e).toContain("      - name: Install Podman");
    expect(providerLandoE2e).toContain("          sudo sysctl net.ipv4.ip_unprivileged_port_start=0");
    expect(providerLandoE2e).toContain("      - name: Start Podman socket");
    expect(providerLandoE2e).toContain("      - name: Build Linux x64 binary");
    expect(providerLandoE2e).toContain("      - name: Run smoke e2e scenarios");
    expect(providerLandoE2e).toContain(
      '          LANDO_MVP_BINARY_PATH="$GITHUB_WORKSPACE/core/dist/lando" LANDO_SCENARIO_E2E_BINARY="$GITHUB_WORKSPACE/core/dist/lando" bun test core/test/scenario --test-name-pattern="@smoke"',
    );
    expect(providerLandoE2e).toContain("          LANDO_TEST_PODMAN_SOCKET: /tmp/podman.sock");
    expect(providerLandoE2e).toContain("          LANDO_CONFIG__default_provider_id: lando");
    expect(providerLandoE2e).toContain("      - name: Run non-smoke e2e scenarios");
    expect(providerLandoE2e).toContain(
      '          LANDO_MVP_BINARY_PATH="$GITHUB_WORKSPACE/core/dist/lando" LANDO_SCENARIO_E2E_BINARY="$GITHUB_WORKSPACE/core/dist/lando" bun test core/test/scenario --test-name-pattern="^(?!.*@smoke).*$"',
    );
    expect(providerLandoE2e).toContain("      - name: Teardown Podman");
    expect(providerLandoE2e).toContain("          rm -f /tmp/podman.sock /tmp/podman-service.pid");
    expect(providerLandoE2e).toContain("      - name: Collect provider-lando e2e diagnostics");
    expect(providerLandoE2e).toContain("      - name: Upload provider-lando e2e diagnostics");
    expect(providerLandoE2e).toContain("          name: provider-lando-e2e-diagnostics-linux-x64");
    expect(providerLandoE2e.indexOf("Run smoke e2e scenarios")).toBeLessThan(
      providerLandoE2e.indexOf("Run non-smoke e2e scenarios"),
    );
    expect(providerLandoE2e.indexOf("Run non-smoke e2e scenarios")).toBeLessThan(
      providerLandoE2e.indexOf("Upload provider-lando e2e diagnostics"),
    );
  });

  test("rehearses the distribution flow on Linux x64 without publishing", async () => {
    const workflow = await readNightlyWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const rehearsal = findIndentedBlock(jobs, "distribution-rehearsal-linux-x64", 2);

    expect(rehearsal).toContain("    runs-on: ubuntu-24.04");
    expect(rehearsal).toContain("        uses: oven-sh/setup-bun@v2");
    expect(rehearsal).toContain("          bun-version-file: .bun-version");
    expect(rehearsal).toContain("        run: bun install --frozen-lockfile");
    expect(rehearsal).toContain("        run: bun run --filter='@lando/core' build:manifest");

    expect(rehearsal).toContain("      - name: Compile all platform binaries");
    expect(rehearsal).toContain("          mkdir -p dist/bundle");
    for (const target of [
      "bun-linux-x64 --outfile ./dist/bundle/lando-linux-x64",
      "bun-linux-arm64 --outfile ./dist/bundle/lando-linux-arm64",
      "bun-darwin-x64 --outfile ./dist/bundle/lando-darwin-x64",
      "bun-darwin-arm64 --outfile ./dist/bundle/lando-darwin-arm64",
      "bun-windows-x64 --outfile ./dist/bundle/lando-windows-x64.exe",
    ]) {
      expect(rehearsal).toContain(
        `          bun build ./core/bin/lando.ts --compile --target=${target} --sourcemap=external`,
      );
    }
    expect(rehearsal).toContain(
      "          bun run scripts/sanitize-compiled-binary.ts ./dist/bundle/lando-linux-x64",
    );
    expect(rehearsal).toContain("          ./dist/bundle/lando-linux-x64 --version");

    expect(rehearsal).toContain("      - name: Package distribution bundle");
    expect(rehearsal).toContain("        run: bun run scripts/dist-bundle.ts dist/bundle");
    expect(rehearsal).toContain("      - name: Verify SHA256SUMS match the binaries");
    expect(rehearsal).toContain("        run: bun run scripts/dist-bundle.ts --verify dist/bundle");

    expect(rehearsal).toContain("      - name: Upload distribution rehearsal bundle");
    expect(rehearsal).toContain("        uses: actions/upload-artifact@v4");
    expect(rehearsal).toContain(
      "          name: lando-dist-rehearsal-v4.0.0-nightly.${{ github.run_number }}",
    );
    expect(rehearsal).toContain("          path: dist/bundle");
    expect(rehearsal).toContain("          if-no-files-found: error");
    expect(rehearsal).toContain("          retention-days: 14");

    expect(rehearsal).not.toContain("gh release");
    expect(rehearsal).not.toContain("npm publish");

    expect(rehearsal.indexOf("Compile all platform binaries")).toBeLessThan(
      rehearsal.indexOf("Package distribution bundle"),
    );
    expect(rehearsal.indexOf("Package distribution bundle")).toBeLessThan(
      rehearsal.indexOf("Verify SHA256SUMS match the binaries"),
    );
    expect(rehearsal.indexOf("Verify SHA256SUMS match the binaries")).toBeLessThan(
      rehearsal.indexOf("Upload distribution rehearsal bundle"),
    );
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
      "        platform: [darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64]",
    );
    expect(staticChecksPlatform).toContain("    runs-on: ${{ matrix.runs-on }}");
    expect(staticChecksPlatform).toContain("    timeout-minutes: 35");
    expect(staticChecksPlatform).toContain("        uses: oven-sh/setup-bun@v2");
    expect(staticChecksPlatform).toContain("          bun-version-file: .bun-version");
    expect(staticChecksPlatform).toContain("        run: bun install --frozen-lockfile");
    expect(staticChecksPlatform).toContain("        run: bun run typecheck");
    expect(staticChecksPlatform).toContain("        run: bun run lint");
    expect(staticChecksPlatform).toContain("        run: bun run check:renderer-boundary");
    expect(staticChecksPlatform).toContain("      - name: Static scope notice for portable-only platforms");
    expect(staticChecksPlatform).toContain("        if: ${{ matrix.platform != 'linux-x64' }}");
    expect(staticChecksPlatform).toContain(
      "runs fork-safe portable static gates only; linux-x64 runs the full static test suite",
    );
    expect(staticChecksPlatform).toContain("      - name: Unit test layer (linux-x64 full static scope)");
    expect(staticChecksPlatform).toContain("        if: ${{ matrix.platform == 'linux-x64' }}");
    expect(staticChecksPlatform).toContain("        run: bun run test:unit");
    expect(staticChecksPlatform).toContain(
      "      - name: Effect service, CLI, and scenario test layers (linux-x64 full static scope)",
    );
    expect(staticChecksPlatform).toContain(
      "        run: bun test core/test/services core/test/cli core/test/scenario",
    );
    expect(staticChecksPlatform).toContain("      - name: Recipe test layer (linux-x64 full static scope)");
    expect(staticChecksPlatform).toContain(
      "        run: bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts",
    );
    expect(staticChecksPlatform).toContain(
      "      - name: Library API test layer (linux-x64 full static scope)",
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
    expect(buildLinux).toContain("          ./dist/lando shellenv");
    expect(buildLinux).toContain("        uses: actions/upload-artifact@v4");
    expect(buildLinux).toContain("        if: always()");
    expect(buildLinux).toContain("          name: lando-linux-x64");
    expect(buildLinux).toContain("          path: dist/lando");
    expect(buildLinux).toContain("          if-no-files-found: ignore");
    expect(buildLinux).toContain("          retention-days: 14");

    expect(buildLinux.indexOf("./dist/lando --help")).toBeLessThan(
      buildLinux.indexOf("./dist/lando shellenv"),
    );
    expect(buildLinux.indexOf("./dist/lando shellenv")).toBeLessThan(
      buildLinux.indexOf("uses: actions/upload-artifact@v4"),
    );
  });

  test("builds and smokes the darwin-arm64 binary with shellenv and 14-day retention", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const buildDarwin = findIndentedBlock(jobs, "build-darwin-arm64", 2);

    expect(buildDarwin).toContain(
      "    needs: [static-checks, schema-snapshot, bundled-codegen, library-api-tests, recipe-tests]",
    );
    expect(buildDarwin).toContain("    runs-on: macos-15");
    expect(buildDarwin).toContain("        run: bun run --filter='@lando/core' build:manifest");
    expect(buildDarwin).toContain(
      "          bun build ./core/bin/lando.ts --compile --target=bun-darwin-arm64 --outfile ./dist/lando --sourcemap=external",
    );
    expect(buildDarwin).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildDarwin).toContain("          test -f dist/lando");
    expect(buildDarwin).toContain("          ./dist/lando --version");
    expect(buildDarwin).toContain("          ./dist/lando --help");
    expect(buildDarwin).toContain("          ./dist/lando shellenv");
    expect(buildDarwin).toContain("        uses: actions/upload-artifact@v4");
    expect(buildDarwin).toContain("        if: always()");
    expect(buildDarwin).toContain("          name: lando-darwin-arm64");
    expect(buildDarwin).toContain("          path: dist/lando");
    expect(buildDarwin).toContain("          if-no-files-found: ignore");
    expect(buildDarwin).toContain("          retention-days: 14");

    expect(buildDarwin.indexOf("./dist/lando --help")).toBeLessThan(
      buildDarwin.indexOf("./dist/lando shellenv"),
    );
    expect(buildDarwin.indexOf("./dist/lando shellenv")).toBeLessThan(
      buildDarwin.indexOf("uses: actions/upload-artifact@v4"),
    );
  });

  test("builds and smokes the windows-x64 binary on windows-2022 with exit-code + UTF-8 coverage and 14-day retention", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const buildWindows = findIndentedBlock(jobs, "build-windows-x64", 2);

    expect(buildWindows).toContain(
      "    needs: [static-checks, schema-snapshot, bundled-codegen, library-api-tests, recipe-tests]",
    );
    expect(buildWindows).toContain("    runs-on: windows-2022");
    expect(buildWindows).toContain("        run: bun run --filter='@lando/core' build:manifest");
    expect(buildWindows).toContain(
      "          bun build ./core/bin/lando.ts --compile --target=bun-windows-x64 --outfile ./dist/lando-windows-x64.exe --sourcemap=external",
    );
    expect(buildWindows).toContain(
      "          bun run scripts/sanitize-compiled-binary.ts ./dist/lando-windows-x64.exe",
    );
    expect(buildWindows).toContain("          test -f dist/lando-windows-x64.exe");
    expect(buildWindows).toContain(
      "          bun run scripts/smoke-windows-binary.ts ./dist/lando-windows-x64.exe",
    );
    expect(buildWindows).not.toContain("          ./dist/lando-windows-x64.exe --version");
    expect(buildWindows).not.toContain("          ./dist/lando-windows-x64.exe shellenv");
    expect(buildWindows).toContain("        uses: actions/upload-artifact@v4");
    expect(buildWindows).toContain("        if: always()");
    expect(buildWindows).toContain("          name: lando-windows-x64");
    expect(buildWindows).toContain("          path: dist/lando-windows-x64.exe");
    expect(buildWindows).toContain("          if-no-files-found: ignore");
    expect(buildWindows).toContain("          retention-days: 14");

    expect(buildWindows.indexOf("--outfile ./dist/lando-windows-x64.exe")).toBeLessThan(
      buildWindows.indexOf("bun run scripts/smoke-windows-binary.ts"),
    );
    expect(buildWindows.indexOf("bun run scripts/smoke-windows-binary.ts")).toBeLessThan(
      buildWindows.indexOf("uses: actions/upload-artifact@v4"),
    );
  });

  test("builds and smokes the darwin-x64 binary on the current Intel image with 14-day retention", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const buildDarwin = findIndentedBlock(jobs, "build-darwin-x64", 2);

    expect(buildDarwin).toContain(
      "    needs: [static-checks, schema-snapshot, bundled-codegen, library-api-tests, recipe-tests]",
    );
    expect(buildDarwin).toContain("    runs-on: macos-15-intel");
    expect(buildDarwin).toContain("        run: bun run --filter='@lando/core' build:manifest");
    expect(buildDarwin).toContain(
      "          bun build ./core/bin/lando.ts --compile --target=bun-darwin-x64 --outfile ./dist/lando --sourcemap=external",
    );
    expect(buildDarwin).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildDarwin).toContain("          test -f dist/lando");
    expect(buildDarwin).toContain("          ./dist/lando --version");
    expect(buildDarwin).toContain("          ./dist/lando --help");
    expect(buildDarwin).toContain("          ./dist/lando shellenv");
    expect(buildDarwin).toContain("        uses: actions/upload-artifact@v4");
    expect(buildDarwin).toContain("        if: always()");
    expect(buildDarwin).toContain("          name: lando-darwin-x64");
    expect(buildDarwin).toContain("          path: dist/lando");
    expect(buildDarwin).toContain("          if-no-files-found: ignore");
    expect(buildDarwin).toContain("          retention-days: 14");

    expect(buildDarwin.indexOf("./dist/lando --help")).toBeLessThan(
      buildDarwin.indexOf("./dist/lando shellenv"),
    );
    expect(buildDarwin.indexOf("./dist/lando shellenv")).toBeLessThan(
      buildDarwin.indexOf("uses: actions/upload-artifact@v4"),
    );
  });

  test("builds and smokes the linux-arm64 binary on the hosted ARM runner with 14-day retention", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const buildLinuxArm = findIndentedBlock(jobs, "build-linux-arm64", 2);

    expect(buildLinuxArm).toContain(
      "    needs: [static-checks, schema-snapshot, bundled-codegen, library-api-tests, recipe-tests]",
    );
    expect(buildLinuxArm).toContain("    runs-on: ubuntu-24.04-arm");
    expect(buildLinuxArm).toContain("        run: bun run --filter='@lando/core' build:manifest");
    expect(buildLinuxArm).toContain(
      "          bun build ./core/bin/lando.ts --compile --target=bun-linux-arm64 --outfile ./dist/lando --sourcemap=external",
    );
    expect(buildLinuxArm).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildLinuxArm).toContain("          test -f dist/lando");
    expect(buildLinuxArm).toContain("          ./dist/lando --version");
    expect(buildLinuxArm).toContain("          ./dist/lando --help");
    expect(buildLinuxArm).toContain("          ./dist/lando shellenv");
    expect(buildLinuxArm).toContain("        uses: actions/upload-artifact@v4");
    expect(buildLinuxArm).toContain("        if: always()");
    expect(buildLinuxArm).toContain("          name: lando-linux-arm64");
    expect(buildLinuxArm).toContain("          path: dist/lando");
    expect(buildLinuxArm).toContain("          if-no-files-found: ignore");
    expect(buildLinuxArm).toContain("          retention-days: 14");

    expect(buildLinuxArm.indexOf("./dist/lando --help")).toBeLessThan(
      buildLinuxArm.indexOf("./dist/lando shellenv"),
    );
    expect(buildLinuxArm.indexOf("./dist/lando shellenv")).toBeLessThan(
      buildLinuxArm.indexOf("uses: actions/upload-artifact@v4"),
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

    for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"]) {
      expect(workflow).toContain(`build-${platform}:`);
      expect(workflow).toContain(`provider-integration-${platform}:`);
      expect(workflow).toContain(`name: lando-${platform}`);
    }

    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("runs-on: macos-15-intel");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("runs-on: windows-2022");
    expect(workflow).toContain("--target=bun-windows-x64 --outfile ./dist/lando-windows-x64.exe");
    expect(workflow).toContain(
      "bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts",
    );
  });
});
