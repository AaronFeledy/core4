import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scenarioSmokePath = resolve(repoRoot, "core/test/scenario/mvp-exit-criteria.scenario.test.ts");
const workflowsDir = resolve(repoRoot, ".github/workflows");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");
const nightlyWorkflowPath = resolve(repoRoot, ".github/workflows/nightly.yml");
const providerMatrixWorkflowPath = resolve(repoRoot, ".github/workflows/provider-matrix.yml");
const runtimeBundleWorkflowPath = resolve(repoRoot, ".github/workflows/runtime-bundle.yml");
const guideScenarioRunCommand =
  "bun run scripts/test-reporters/run-guide-scenarios.ts test/scenarios/generated/guides/**";
const guideScenarioRunLine = `        run: ${guideScenarioRunCommand}`;

const readWorkflow = async (): Promise<string> => Bun.file(workflowPath).text();
const readNightlyWorkflow = async (): Promise<string> => Bun.file(nightlyWorkflowPath).text();
const readProviderMatrixWorkflow = async (): Promise<string> => Bun.file(providerMatrixWorkflowPath).text();
const readRuntimeBundleWorkflow = async (): Promise<string> => Bun.file(runtimeBundleWorkflowPath).text();

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

    expect(activeWorkflowFiles).toEqual([
      "ci.yml",
      "nightly.yml",
      "php-base-images.yml",
      "provider-matrix.yml",
      "release.yml",
      "runtime-bundle.yml",
    ]);
  });

  test("runs the weekly provider matrix with release-blocking Linux acceptance reports", async () => {
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
    expect(providerContracts).toContain("            engine: Lando managed Podman 6");
    expect(providerContracts).toContain("            engine: Podman 6");
    expect(providerContracts).toContain("            engine: Lima");
    expect(providerContracts).toContain("            engine: OrbStack");
    expect((providerContracts.match(/release-blocking: true/g) ?? []).length).toBe(3);
    expect((providerContracts.match(/advisory-skip: true/g) ?? []).length).toBe(4);
    expect(providerContracts).toContain("      - name: Notice unsupported hosted runner cell");
    expect(providerContracts).toContain("        if: ${{ matrix['advisory-skip'] == true }}");
    expect(providerContracts).toContain("      - name: Setup Bun");
    expect(providerContracts).toContain("          bun-version-file: .bun-version");
    expect(providerContracts).toContain("        run: bun install --frozen-lockfile");
    expect(providerContracts).toContain("      - name: Build Linux x64 binary for managed Lando provider");
    expect(providerContracts).toContain("          bun run --filter='@lando/core' build:manifest");
    expect(providerContracts).toContain("          bun run --filter='@lando/core' build:log-file-helper");
    expect(providerContracts).toContain(
      "          bun -e \"const fs = await import('node:fs/promises'); await fs.cp('core/dist/log-file-access', 'dist/log-file-access', { recursive: true });\"",
    );
    expect(providerContracts).toContain(
      "          bun run scripts/build-compiled-binary.ts --target bun-linux-x64 --outfile ./dist/lando --minify --sourcemap=external",
    );
    expect(providerContracts).toContain(
      "      - name: Prepare managed Lando provider from committed manifest",
    );
    expect(providerContracts).toContain('          test -z "${LANDO_RUNTIME_BUNDLE_MANIFEST:-}"');
    expect(providerContracts).toContain('          test -z "${LANDO_RUNTIME_BUNDLE_URL:-}"');
    expect(providerContracts).toContain('          test -z "${LANDO_RUNTIME_BUNDLE_SHA256:-}"');
    expect(providerContracts).toContain('          export LANDO_USER_CONF_ROOT="$RUNNER_TEMP/lando-conf"');
    expect(providerContracts).toContain('          export LANDO_USER_DATA_ROOT="$RUNNER_TEMP/lando-data"');
    expect(providerContracts).toContain('          export LANDO_USER_CACHE_ROOT="$RUNNER_TEMP/lando-cache"');
    expect(providerContracts).toContain(
      "          dist/lando setup --yes --provider=lando --skip-install-ca --skip-shell-integration --skip-file-sync",
    );
    expect(providerContracts).toContain("      - name: Verify managed Lando socket");
    expect(providerContracts).toContain(
      '          test -S "$RUNNER_TEMP/lando-data/runtime/run/podman.sock"',
    );
    expect(providerContracts).toContain(
      '          echo "LANDO_TEST_PODMAN_SOCKET=$RUNNER_TEMP/lando-data/runtime/run/podman.sock" >> "$GITHUB_ENV"',
    );
    expect(providerContracts).toContain("      - name: Install Podman 6 toolchain");
    expect(providerContracts).toContain("        if: ${{ matrix.cell == 'podman-podman6-linux' }}");
    expect(providerContracts).toContain("      - name: Assert Podman 6 host contract");
    expect(providerContracts).toContain("      - name: Start Podman socket");
    expect(providerContracts).toContain("        if: ${{ matrix.cell == 'podman-podman6-linux' }}");
    expect(providerContracts).toContain("      - name: Configure Docker socket");
    expect(providerContracts).toContain("      - name: Pull live acceptance fixture images");
    expect(providerContracts).toContain(
      '                CONTAINERS_REGISTRIES_CONF="$RUNNER_TEMP/lando-data/runtime/config/registries.conf" "$RUNNER_TEMP/lando-data/runtime/bin/podman" --url "unix://$LANDO_TEST_PODMAN_SOCKET" pull "$image"',
    );
    expect(providerContracts).toContain(
      '              podman --url "unix://$LANDO_TEST_PODMAN_SOCKET" pull "$image"',
    );
    expect(providerContracts).toContain('              docker pull "$image"');
    expect(providerContracts).toContain("      - name: Run structured provider acceptance cell");
    expect(providerContracts).toContain("        if: always()");
    expect(providerContracts).toContain(
      "          bun run scripts/provider-matrix-acceptance.ts --cell '${{ matrix.cell }}' --report-dir provider-matrix-reports",
    );
    expect(providerContracts).toContain("      - name: Upload provider matrix cell report");
    expect(providerContracts).toContain("          name: provider-matrix-report-${{ matrix.cell }}");
    expect(providerContracts).toContain("          path: provider-matrix-reports/${{ matrix.cell }}.json");
    expect(providerContracts).toContain("          if-no-files-found: error");
    expect(providerContracts).toContain("      - name: Teardown Podman");
    expect(providerContracts).toContain(
      "        if: ${{ always() && matrix.cell == 'podman-podman6-linux' }}",
    );
    expect(providerContracts).toContain("      - name: Teardown managed Lando runtime");
    expect(providerContracts).toContain(
      "        if: ${{ always() && matrix.cell == 'lando-podman6-linux' }}",
    );
    expect(providerContracts).toContain("          dist/lando poweroff || true");
    expect(providerContracts).toContain("      - name: Provision Linux rootless runtime prerequisites");
    expect(providerContracts).toContain(
      "        if: ${{ matrix.cell == 'lando-podman6-linux' || matrix.cell == 'podman-podman6-linux' }}",
    );
    expect(providerContracts).toContain(
      "            sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(providerContracts).toContain(
      '          mount_program = "$LANDO_USER_DATA_ROOT/runtime/bin/fuse-overlayfs"',
    );
    expect(providerContracts).toContain(
      '          echo "CONTAINERS_STORAGE_CONF=$CONTAINERS_STORAGE_CONF" >> "$GITHUB_ENV"',
    );
    expect(providerContracts).toContain("      - name: Collect provider matrix diagnostics");
    expect(providerContracts).toContain(
      '            cp "$LANDO_USER_DATA_ROOT/runtime/run/service.log" provider-matrix-diagnostics/lando-managed-service.log || true',
    );
    expect(providerContracts).toContain(
      '            cp -r "$LANDO_USER_CACHE_ROOT/logs" provider-matrix-diagnostics/lando-logs || true',
    );
    expect(providerContracts).toContain("      - name: Upload provider matrix diagnostics");
    expect(providerContracts).toContain("          name: provider-matrix-diagnostics-${{ matrix.cell }}");
    expect(providerContracts).not.toContain("      - name: Run provider contract tests");
  });

  test("dispatches the provider matrix after runtime bundle manifest repins", async () => {
    const workflow = await readRuntimeBundleWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const publish = findIndentedBlock(jobs, "publish", 2);
    const permissions = findIndentedBlock(publish, "permissions", 4);

    expect(permissions).toContain("      contents: write");
    expect(permissions).toContain("      actions: write");
    expect(publish).toContain("      - name: Commit recovered manifest pin");
    expect(publish).toContain("        id: manifest-pin");
    expect(publish).toContain("          git push origin HEAD:main");
    expect(publish).toContain('          echo "pushed=true" >> "$GITHUB_OUTPUT"');
    expect(publish).toContain("      - name: Dispatch provider matrix after manifest repin");
    expect(publish).toContain("        if: steps.manifest-pin.outputs.pushed == 'true'");
    expect(publish).toContain(
      '        run: GITHUB_TOKEN="${{ github.token }}" gh workflow run provider-matrix.yml --ref main',
    );
    expect(publish.indexOf("git push origin HEAD:main")).toBeLessThan(
      publish.indexOf("Dispatch provider matrix after manifest repin"),
    );
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
    expect(providerLandoE2e).toContain("      - name: Install Podman 6 toolchain");
    expect(providerLandoE2e).toContain("      - name: Assert Podman 6 host contract");
    expect(providerLandoE2e).toContain("        run: sudo sysctl net.ipv4.ip_unprivileged_port_start=0");
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
    expect(rehearsal).toContain('          bun install --frozen-lockfile --os="*" --cpu="*"');
    for (const target of [
      "bun-linux-x64 --outfile ./dist/bundle/lando-linux-x64",
      "bun-linux-arm64 --outfile ./dist/bundle/lando-linux-arm64",
      "bun-darwin-x64 --outfile ./dist/bundle/lando-darwin-x64",
      "bun-darwin-arm64 --outfile ./dist/bundle/lando-darwin-arm64",
      "bun-windows-x64 --outfile ./dist/bundle/lando-windows-x64.exe",
    ]) {
      expect(rehearsal).toContain(
        `          bun run scripts/build-compiled-binary.ts --target ${target} --minify --sourcemap=external`,
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
    const unitTests = findIndentedBlock(jobs, "unit-tests-linux-x64", 2);

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
    expect(staticChecksPlatform).toContain("      - name: Import cycle lint");
    expect(staticChecksPlatform).toContain("        run: bun run check:import-cycle");
    expect(staticChecksPlatform).toContain("        run: bun run check:renderer-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:managed-file-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:telemetry-inventory");
    expect(staticChecksPlatform).toContain("        run: bun run check:redaction-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:env-helper-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:paths-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:state-store-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:probe-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:network-boundary");
    expect(staticChecksPlatform).toContain("        run: bun run check:machine-output");
    expect(staticChecksPlatform).toContain("      - name: Static scope notice for portable static matrix");
    expect(staticChecksPlatform).toContain(
      "runs fork-safe portable static gates only; linux-x64 unit tests run as unit-tests-linux-x64",
    );
    expect(staticChecksPlatform).not.toContain("bun run test:unit");
    expect(staticChecksPlatform).not.toContain(
      "bun test core/test/services core/test/cli core/test/scenario",
    );
    expect(staticChecksPlatform).not.toContain(
      "bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts",
    );
    expect(staticChecksPlatform).not.toContain("bun test core/test/library sdk/test/library");
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

    const unitTestShards = findIndentedBlock(jobs, "unit-tests-linux-x64-shard", 2);
    expect(unitTestShards).not.toContain("    needs:");
    expect(unitTestShards).toContain("        shard: [1, 2, 3]");
    expect(unitTestShards).toContain("    runs-on: ubuntu-24.04");
    expect(unitTestShards).toContain("    timeout-minutes: 25");
    expect(unitTestShards).toContain("      - name: Unit test shard");
    expect(unitTestShards).toContain("        run: bun run test:unit:shard ${{ matrix.shard }}/3");
    expect(unitTests).toContain("    needs: [unit-tests-linux-x64-shard]");
    expect(unitTests).toContain("    if: always()");
    expect(unitTests).toContain(
      '          if [[ "${{ needs.unit-tests-linux-x64-shard.result }}" != "success" ]]; then',
    );
  });

  test("uses minimal read-only permissions for fork-safe pull requests", async () => {
    const workflow = await readWorkflow();
    const permissions = findIndentedBlock(workflow, "permissions");

    expect(permissions).toContain("  contents: read");
    expect(permissions).toContain("  pull-requests: read");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("contents: write");
  });

  test("regenerates and drift-checks the OpenTUI native catalog", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const bundledCodegen = findIndentedBlock(jobs, "bundled-codegen", 2);

    expect(bundledCodegen).toContain("        run: bun run codegen:opentui-native-stubs");
    expect(bundledCodegen).toContain("scripts/generated/opentui-native");
  });

  test("runs relocated OpenTUI acceptance on every release-target binary", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    for (const [target, binary] of [
      ["darwin-arm64", "lando"],
      ["darwin-x64", "lando"],
      ["linux-arm64", "lando"],
      ["linux-x64", "lando"],
      ["windows-x64", "lando-windows-x64.exe"],
    ] as const) {
      const build = findIndentedBlock(jobs, `build-${target}`, 2);
      expect(build).toContain(`          LANDO_RELEASE_TARGET: ${target}`);
      expect(build).toContain(`          LANDO_OPENTUI_ACCEPTANCE_BINARY: ./dist/${binary}`);
      expect(build).toContain("        run: bun test core/test/build/opentui-compiled-acceptance.test.ts");
    }
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
    expect(buildLinux).toContain("          bun run --filter='@lando/core' build:host-proxy-shim");
    expect(buildLinux).toContain("          bun run --filter='@lando/core' build:log-file-helper");
    expect(buildLinux).toContain(
      "          bun -e \"const fs = await import('node:fs/promises'); await fs.cp('core/dist/host-proxy', 'dist/host-proxy', { recursive: true }); await fs.cp('core/dist/log-file-access', 'dist/log-file-access', { recursive: true });\"",
    );
    expect(buildLinux).toContain(
      "          bun run scripts/build-compiled-binary.ts --target bun-linux-x64 --outfile ./dist/lando --minify --sourcemap=external",
    );
    expect(buildLinux).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildLinux).toContain("          test -f dist/lando");
    expect(buildLinux).toContain("          ./dist/lando --version");
    expect(buildLinux).toContain("          ./dist/lando --help");
    expect(buildLinux).toContain("          ./dist/lando shellenv");
    expect(buildLinux).toContain("        uses: actions/upload-artifact@v4");
    expect(buildLinux).toContain("        if: always()");
    expect(buildLinux).toContain("          name: lando-linux-x64");
    expect(buildLinux).toContain("          path: |");
    expect(buildLinux).toContain("            dist/lando");
    expect(buildLinux).toContain("            dist/host-proxy/**");
    expect(buildLinux).toContain("            dist/log-file-access/**");
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
      "          bun run scripts/build-compiled-binary.ts --target bun-darwin-arm64 --outfile ./dist/lando --minify --sourcemap=external",
    );
    expect(buildDarwin).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildDarwin).toContain("          test -f dist/lando");
    expect(buildDarwin).toContain("          ./dist/lando --version");
    expect(buildDarwin).toContain("          ./dist/lando --help");
    expect(buildDarwin).toContain("          ./dist/lando shellenv");
    expect(buildDarwin).toContain("        uses: actions/upload-artifact@v4");
    expect(buildDarwin).toContain("        if: always()");
    expect(buildDarwin).toContain("          name: lando-darwin-arm64");
    expect(buildDarwin).toContain("          path: |");
    expect(buildDarwin).toContain("            dist/lando");
    expect(buildDarwin).toContain("            dist/host-proxy/**");
    expect(buildDarwin).toContain("            dist/log-file-access/**");
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
      "    needs: [static-checks, schema-snapshot, bundled-codegen, library-api-tests, recipe-tests, build-linux-x64]",
    );
    expect(buildWindows).toContain("    runs-on: windows-2022");
    expect(buildWindows).toContain("      - name: Download Linux sidecars from Linux artifact");
    expect(buildWindows).toContain("          name: lando-linux-x64");
    expect(buildWindows).toContain("          path: linux-sidecars");
    expect(buildWindows).toContain("        run: bun run --filter='@lando/core' build:manifest");
    expect(buildWindows).not.toContain("          bun run --filter='@lando/core' build:host-proxy-shim");
    expect(buildWindows).toContain(
      "          bun -e \"const fs = await import('node:fs/promises'); await fs.cp('linux-sidecars/host-proxy', 'dist/host-proxy', { recursive: true }); await fs.cp('linux-sidecars/log-file-access', 'dist/log-file-access', { recursive: true });\"",
    );
    expect(buildWindows).toContain(
      "          bun run scripts/build-compiled-binary.ts --target bun-windows-x64 --outfile ./dist/lando-windows-x64.exe --minify --sourcemap=external",
    );
    expect(buildWindows).toContain(
      "          bun run scripts/sanitize-compiled-binary.ts ./dist/lando-windows-x64.exe",
    );
    expect(buildWindows).not.toContain("test -f dist/lando-windows-x64.exe");
    expect(buildWindows).toContain(
      "          bun run scripts/smoke-windows-binary.ts ./dist/lando-windows-x64.exe",
    );
    expect(buildWindows).not.toContain("shell: pwsh");
    expect(buildWindows).not.toContain("[Console]::OutputEncoding");
    expect(buildWindows).not.toContain("          ./dist/lando-windows-x64.exe --version");
    expect(buildWindows).not.toContain("          ./dist/lando-windows-x64.exe shellenv");
    expect(buildWindows).toContain("        uses: actions/upload-artifact@v4");
    expect(buildWindows).toContain("        if: always()");
    expect(buildWindows).toContain("          name: lando-windows-x64");
    expect(buildWindows).toContain("          path: |");
    expect(buildWindows).toContain("            dist/lando-windows-x64.exe");
    expect(buildWindows).toContain("            dist/host-proxy/**");
    expect(buildWindows).toContain("            dist/log-file-access/**");
    expect(buildWindows).toContain("          if-no-files-found: ignore");
    expect(buildWindows).toContain("          retention-days: 14");

    expect(buildWindows.indexOf("path: linux-sidecars")).toBeLessThan(
      buildWindows.indexOf("run: bun run --filter='@lando/core' build:manifest"),
    );
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
      "          bun run scripts/build-compiled-binary.ts --target bun-darwin-x64 --outfile ./dist/lando --minify --sourcemap=external",
    );
    expect(buildDarwin).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildDarwin).toContain("          test -f dist/lando");
    expect(buildDarwin).toContain("          ./dist/lando --version");
    expect(buildDarwin).toContain("          ./dist/lando --help");
    expect(buildDarwin).toContain("          ./dist/lando shellenv");
    expect(buildDarwin).toContain("        uses: actions/upload-artifact@v4");
    expect(buildDarwin).toContain("        if: always()");
    expect(buildDarwin).toContain("          name: lando-darwin-x64");
    expect(buildDarwin).toContain("          path: |");
    expect(buildDarwin).toContain("            dist/lando");
    expect(buildDarwin).toContain("            dist/host-proxy/**");
    expect(buildDarwin).toContain("            dist/log-file-access/**");
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
      "          bun run scripts/build-compiled-binary.ts --target bun-linux-arm64 --outfile ./dist/lando --minify --sourcemap=external",
    );
    expect(buildLinuxArm).toContain("          bun run scripts/sanitize-compiled-binary.ts ./dist/lando");
    expect(buildLinuxArm).toContain("          test -f dist/lando");
    expect(buildLinuxArm).toContain("          ./dist/lando --version");
    expect(buildLinuxArm).toContain("          ./dist/lando --help");
    expect(buildLinuxArm).toContain("          ./dist/lando shellenv");
    expect(buildLinuxArm).toContain("        uses: actions/upload-artifact@v4");
    expect(buildLinuxArm).toContain("        if: always()");
    expect(buildLinuxArm).toContain("          name: lando-linux-arm64");
    expect(buildLinuxArm).toContain("          path: |");
    expect(buildLinuxArm).toContain("            dist/lando");
    expect(buildLinuxArm).toContain("            dist/host-proxy/**");
    expect(buildLinuxArm).toContain("            dist/log-file-access/**");
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

    expect(guideScenarios).toContain("    needs: [static-checks, build-linux-x64]");
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
    expect(guideScenarios).toContain("          GH_TOKEN: ${{ github.token }}");
    expect(guideScenarios).toContain(
      '          GUIDE_DRIFT_PR_BODY="$(gh pr view ${{ github.event.pull_request.number }} --json body --jq .body)" bun run check:guide-drift',
    );
    expect(guideScenarios).toContain(guideScenarioRunLine);
    expect(guideScenarios).toContain("      - name: Download Linux x64 binary artifact");
    expect(guideScenarios).toContain("          name: lando-linux-x64");
    expect(guideScenarios).toContain("        run: chmod +x dist/lando");
    expect(guideScenarios).toContain("      - name: Provision rootless runtime prerequisites");
    expect(guideScenarios).toContain("      - name: Prepare provider via lando setup");
    expect(guideScenarios).toContain("          dist/lando setup --yes --provider=lando");
    expect(guideScenarios).toContain("      - name: Verify managed runtime socket");
    expect(guideScenarios).not.toContain(
      '          echo "LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock" >> "$GITHUB_ENV"',
    );
    expect(guideScenarios).toContain("      - name: Install Podman 6 toolchain");
    expect(guideScenarios).toContain("      - name: Assert Podman 6 host contract");
    expect(guideScenarios).not.toContain("podman system service");
    expect(guideScenarios).toContain("      - name: Run e2e smoke guide scenarios");
    expect(guideScenarios).toContain('          LANDO_GUIDE_E2E: "1"');
    expect(guideScenarios).toContain(
      `        run: LANDO_MVP_BINARY_PATH="$GITHUB_WORKSPACE/dist/lando" LANDO_SCENARIO_E2E_BINARY="$GITHUB_WORKSPACE/dist/lando" ${guideScenarioRunCommand} --max-concurrency=1 --test-name-pattern="@smoke.*\\[e2e\\]"`,
    );
    expect(guideScenarios).toContain("      - name: Teardown guide e2e provider");
    expect(guideScenarios).toContain("          dist/lando poweroff || true");
    expect(guideScenarios).toContain('          LANDO_PODMAN="$HOME/.local/share/lando/runtime/bin/podman"');
    expect(guideScenarios).toContain("      - name: Upload guide e2e provider diagnostics");
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
      guideScenarios.indexOf(guideScenarioRunCommand),
    );
    expect(guideScenarios.indexOf(guideScenarioRunCommand)).toBeLessThan(
      guideScenarios.indexOf("Download Linux x64 binary artifact"),
    );
    expect(guideScenarios.indexOf("Download Linux x64 binary artifact")).toBeLessThan(
      guideScenarios.indexOf("Run e2e smoke guide scenarios"),
    );
    expect(guideScenarios.indexOf("Upload guide scenario transcripts")).toBeGreaterThan(
      guideScenarios.indexOf("Run e2e smoke guide scenarios"),
    );
  });

  test("runs generated guide scenarios on non-Linux-x64 platforms without e2e provider setup", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const guideScenarioJobs = [
      ["guide-scenarios-darwin-arm64", "macos-15"],
      ["guide-scenarios-darwin-x64", "macos-15-intel"],
      ["guide-scenarios-linux-arm64", "ubuntu-24.04-arm"],
      ["guide-scenarios-windows-x64", "windows-2022"],
    ] as const;

    for (const [jobId, runsOn] of guideScenarioJobs) {
      const guideScenarios = findIndentedBlock(jobs, jobId, 2);

      expect(guideScenarios).toContain("    needs: [static-checks]");
      expect(guideScenarios).toContain(`    runs-on: ${runsOn}`);
      expect(guideScenarios).toContain("          fetch-depth: 0");
      expect(guideScenarios).toContain("        run: bun run codegen");
      expect(guideScenarios).toContain("        run: bun run typecheck");
      expect(guideScenarios).toContain("        run: bun run lint:guides");
      expect(guideScenarios).toContain("        run: bun run check:guide-coverage");
      expect(guideScenarios).toContain("        run: bun run check:public-transcripts");
      expect(guideScenarios).toContain("      - name: Check guide drift");
      expect(guideScenarios).toContain(guideScenarioRunLine);
      expect(guideScenarios).not.toContain("      - name: Run e2e smoke guide scenarios");
      expect(guideScenarios).not.toContain("      - name: Install Podman");
      expect(guideScenarios).not.toContain("      - name: Download Linux x64 binary artifact");
    }
  });

  test("runs startup and tooling perf budgets as a branch-protectable Linux x64 gate", async () => {
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
    expect(perfBudget).toContain("      - name: Run OpenTUI startup benchmark");
    expect(perfBudget).toContain("        run: bun run bench:opentui-startup -- --binary dist/lando");

    expect(perfBudget.indexOf("Download Linux x64 binary artifact")).toBeLessThan(
      perfBudget.indexOf("Restore binary executable bit"),
    );
    expect(perfBudget.indexOf("Restore binary executable bit")).toBeLessThan(
      perfBudget.indexOf("Run OpenTUI startup benchmark"),
    );
    expect(perfBudget.indexOf("Run OpenTUI startup benchmark")).toBeLessThan(
      perfBudget.indexOf("Run tooling hot-path benchmark"),
    );
  });

  test("prepares the Lando provider via lando setup with no manual socket bring-up", async () => {
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

    expect(providerIntegration).toContain("      - name: Provision rootless runtime prerequisites");
    expect(providerIntegration).toContain("          sudo apt-get install -y uidmap fuse-overlayfs");
    expect(providerIntegration).toContain('grep -q "^$(id -un):" /etc/subuid');
    expect(providerIntegration).toContain("          sudo sysctl net.ipv4.ip_unprivileged_port_start=0");
    expect(providerIntegration).toContain(
      "          if test -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns; then",
    );
    expect(providerIntegration).toContain(
      "            sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(providerIntegration).toContain("systemd.unified_cgroup_hierarchy");

    expect(providerIntegration).toContain("      - name: Stage current-commit runtime bundle");
    expect(providerIntegration).toContain("          mkdir -p dist/cache/runtime-bundle");
    expect(providerIntegration).toContain('          cp "$(command -v podman)" "$STAGE/podman"');
    expect(providerIntegration).toContain(
      '          if test -z "$src" && test -x "/usr/lib/podman/$helper"; then src="/usr/lib/podman/$helper"; fi',
    );
    expect(providerIntegration).toContain("netavark aardvark-dns gvproxy");
    expect(providerIntegration).toContain('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"');
    expect(providerIntegration).toContain('mkdir -p "$XDG_RUNTIME_DIR"');
    expect(providerIntegration).not.toContain('          mkdir -p "$STAGE/bin"');
    expect(providerIntegration).not.toContain('          "$STAGE/bin/podman"');
    expect(providerIntegration).toContain("      - name: Build local runtime bundle manifest");
    expect(providerIntegration).toContain(
      '          MANIFEST="$(bun run scripts/build-runtime-bundle.ts --local --platform linux-x64)"',
    );
    expect(providerIntegration).toContain(
      '          echo "LANDO_RUNTIME_BUNDLE_MANIFEST=$MANIFEST" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain("      - name: Configure rootless overlay storage");
    expect(providerIntegration).toContain("          cat > dist/cache/runtime-bundle/storage.conf <<EOF");
    expect(providerIntegration).toContain(
      '          mount_program = "$HOME/.local/share/lando/runtime/bin/fuse-overlayfs"',
    );
    expect(providerIntegration).toContain(
      '          echo "CONTAINERS_STORAGE_CONF=$GITHUB_WORKSPACE/dist/cache/runtime-bundle/storage.conf" >> "$GITHUB_ENV"',
    );
    expect(providerIntegration).toContain("      - name: Prepare provider via lando setup");
    expect(providerIntegration).toContain("          dist/lando setup --yes --provider=lando");
    expect(providerIntegration).toContain(
      '          echo "LANDO_CONFIG__default_provider_id=lando" >> "$GITHUB_ENV"',
    );

    expect(providerIntegration).toContain("      - name: Verify managed runtime socket");
    expect(providerIntegration).toContain(
      '          test -S "$HOME/.local/share/lando/runtime/run/podman.sock"',
    );
    expect(providerIntegration).toContain(
      '          LANDO_PODMAN="$HOME/.local/share/lando/runtime/bin/podman"',
    );
    expect(providerIntegration).toContain(
      '          LANDO_PODMAN_ARGS=(--root "$HOME/.local/share/lando/runtime/storage" --runroot "$HOME/.local/share/lando/runtime/run" --config "$HOME/.local/share/lando/runtime/config")',
    );
    expect(providerIntegration).toContain("          pull_image docker.io/library/node:22-alpine");
    expect(providerIntegration).not.toContain("podman system service");
    expect(providerIntegration).not.toContain("LANDO_TEST_PODMAN_SOCKET");
    expect(providerIntegration).not.toContain("/tmp/podman.sock");
    expect(providerIntegration).not.toContain("/tmp/podman-service.pid");
    expect(providerIntegration).toContain("      - name: Install Podman 6 toolchain");
    expect(providerIntegration).toContain("      - name: Assert Podman 6 host contract");
    expect(providerIntegration).not.toContain("      - name: Start Podman socket");
    expect(providerIntegration).not.toContain("      - name: Teardown Podman");

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
      "          bun test plugins/provider-lando/test/*.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/provider-docker/test/*.integration.test.ts",
    );
    expect(providerIntegration).toContain(
      "          bun test plugins/service-lando/test/*.integration.test.ts",
    );
    expect(providerIntegration).toContain("      - name: Pre-pull container images");
    expect(providerIntegration).toContain("          for attempt in 1 2 3; do");
    expect(providerIntegration).toContain("          pull_image docker.io/library/node:lts");
    expect(providerIntegration).toContain("          pull_image docker.io/library/node:22-alpine");
    expect(providerIntegration).toContain("          pull_image docker.io/library/postgres:16");
    expect(providerIntegration).toContain("          pull_image docker.io/library/postgres:16-alpine");
    expect(providerIntegration).toContain("          pull_image docker.io/library/golang:1.22");
    expect(providerIntegration).toContain("          pull_image docker.io/library/alpine:3.21");
    expect(providerIntegration).toContain("          pull_image docker.io/axllent/mailpit:v1.30.1");
    expect(providerIntegration).toContain("          pull_image docker.io/library/memcached:1.6");
    expect(providerIntegration).toContain("          pull_image docker.io/valkey/valkey:8");
    expect(providerIntegration).toContain("          docker_pull_image docker.io/library/node:22-alpine");

    expect(providerIntegration).toContain("      - name: Teardown Lando runtime");
    expect(providerIntegration).toContain("          dist/lando poweroff");
    expect(providerIntegration).toContain(
      '          "$LANDO_PODMAN" "${LANDO_PODMAN_ARGS[@]}" ps -aq --filter "name=lando-" | xargs -r "$LANDO_PODMAN" "${LANDO_PODMAN_ARGS[@]}" rm -f || true',
    );
    expect(providerIntegration).not.toMatch(
      /Teardown Lando runtime[\s\S]*?podman ps -aq --filter "name=lando-" \| xargs -r podman rm/,
    );
    expect(providerIntegration).toContain("        if: always()");
    expect(providerIntegration).toContain("      - name: Collect provider diagnostics");
    expect(providerIntegration).toContain("        if: failure()");
    expect(providerIntegration).toContain('          journalctl --no-pager --since "-30 minutes"');
    expect(providerIntegration).toContain("      - name: Upload provider integration diagnostics");
    expect(providerIntegration).toContain("        uses: actions/upload-artifact@v4");
    expect(providerIntegration).toContain("          name: provider-integration-diagnostics-linux-x64");
    expect(providerIntegration).toContain("          if-no-files-found: ignore");
    expect(providerIntegration).not.toContain("--silent");

    expect(providerIntegration.indexOf("Prepare provider via lando setup")).toBeLessThan(
      providerIntegration.indexOf("Run provider contract tests"),
    );
    expect(providerIntegration.indexOf("Build local runtime bundle manifest")).toBeLessThan(
      providerIntegration.indexOf("Prepare provider via lando setup"),
    );
    expect(providerIntegration.indexOf("Teardown Lando runtime")).toBeGreaterThan(
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

  test("runs compiled Windows managed setup through machine and API reachability", async () => {
    const workflow = await readWorkflow();
    const jobs = findIndentedBlock(workflow, "jobs");
    const runtimeBundle = findIndentedBlock(jobs, "runtime-bundle-win32-x64", 2);
    const providerIntegration = findIndentedBlock(jobs, "provider-integration-windows-x64", 2);

    expect(runtimeBundle).toContain("    runs-on: ubuntu-24.04");
    expect(runtimeBundle).toContain("      - name: Assemble current-commit Windows runtime bundle");
    expect(runtimeBundle).toContain(
      "        run: bun run scripts/assemble-runtime-bundle.ts --platform win32-x64",
    );
    expect(runtimeBundle).toContain("          name: runtime-bundle-win32-x64-current");
    expect(providerIntegration).toContain("    needs: [build-windows-x64, runtime-bundle-win32-x64]");
    expect(providerIntegration).toContain("      - name: Download current-commit Windows runtime bundle");
    expect(providerIntegration).toContain("      - name: Build local Windows runtime manifest");
    expect(providerIntegration).toContain(
      "          bun run scripts/windows-managed-setup-acceptance.ts --binary dist/lando-windows-x64.exe --report provider-diagnostics/windows-managed-setup.json",
    );
    expect(providerIntegration).toContain("      - name: Teardown Windows managed machine");
    expect(providerIntegration).toContain("& $podman machine rm --force lando");
    expect(providerIntegration).toContain("Remove-Item -Recurse -Force -ErrorAction SilentlyContinue");
    expect(providerIntegration).toContain("exit 0'");
    expect(providerIntegration).toContain("        if: always()");
    expect(providerIntegration.indexOf("Build local Windows runtime manifest")).toBeLessThan(
      providerIntegration.indexOf("windows-managed-setup-acceptance.ts"),
    );
    expect(providerIntegration.indexOf("windows-managed-setup-acceptance.ts")).toBeLessThan(
      providerIntegration.indexOf("Run provider contract tests"),
    );
  });

  test("generates the multi-platform build and provider integration matrix", async () => {
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
    expect(workflow).toContain(
      "--target bun-windows-x64 --outfile ./dist/lando-windows-x64.exe --minify --sourcemap=external",
    );
    expect(workflow).toContain(
      "bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts",
    );
  });
});
