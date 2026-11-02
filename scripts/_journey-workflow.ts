import { containerHelperDownloadStep } from "./_container-helper-workflow.ts";
import { isolateLandoRootsStep as isolateRootsStep } from "./_lando-roots-workflow.ts";
import { landoRootlessPrereqSteps } from "./build-ci-workflow.ts";
import {
  CI_PLATFORMS,
  type CiPlatform,
  type PlatformReadinessCell,
  isWindowsCiPlatform,
} from "./ci-platforms.ts";
import * as supplyChain from "./runtime-bundle-supply-chain.ts";

const SCHEDULE_IF =
  "github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";

export const createJourneyWorkflowBuilder = (workflow: string) => {
  const assertNever = (value: never): never => {
    throw new Error(`Unexpected ${workflow} value: ${String(value)}`);
  };

  const ciPlatformFor = (id: string): CiPlatform => {
    const platform = CI_PLATFORMS.find((candidate) => candidate.id === id);
    if (platform === undefined) {
      throw new Error(`CI_PLATFORMS is missing ${id}`);
    }
    return platform;
  };

  const renderRunsOn = (runsOn: PlatformReadinessCell["runsOn"]): string =>
    typeof runsOn === "string" ? runsOn : `[${runsOn.join(", ")}]`;

  const renderCadenceIf = (cadence: PlatformReadinessCell["cadence"]): string => {
    switch (cadence) {
      case "evidence":
        return `    if: ${SCHEDULE_IF}\n`;
      default:
        return assertNever(cadence);
    }
  };

  const isLinuxLando = (cell: PlatformReadinessCell): boolean =>
    cell.id.startsWith("linux-") && cell.provider === "lando";
  const isLinuxCurrentCommit = (cell: PlatformReadinessCell): boolean =>
    cell.bundleMode === "current-commit" && cell.bundleKey.startsWith("linux-");

  const setupFlags = (cell: PlatformReadinessCell): string => {
    const flags = `--yes --provider=${cell.provider} --skip-install-ca --skip-shell-integration --skip-file-sync`;
    return isWindowsCiPlatform(cell) ? `${flags} --no-interactive` : flags;
  };

  const setupBunSteps = `      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - name: Install dependencies
        run: bun install --frozen-lockfile`;

  const derivedSourcesSteps = `      - name: Regenerate derived sources
        run: bun run codegen

${containerHelperDownloadStep}

      - name: Build command registry manifest
        run: bun run --filter='@lando/core' build:manifest`;

  const renderCompileStep = (platform: CiPlatform): string => `      - name: Build ${platform.id} binary
        run: |
          mkdir -p dist
          VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "0.0.0-dev")
          bun run scripts/build-compiled-binary.ts --target ${platform.bunTarget} --outfile ./dist/${platform.binaryName} --version "$VERSION" --minify --sourcemap=external`;

  const renderLinuxSourceBuildPrereqs = (): string => `
      - name: Setup Go for Linux Podman source build
        uses: ${supplyChain.RUNTIME_BUNDLE_ACTION_PINS.setupGo} # v7.0.0
        with:
          go-version: 1.25.6

      - name: Setup Rust for Linux helper source builds
        uses: ${supplyChain.RUNTIME_BUNDLE_ACTION_PINS.rustToolchain} # 1.88.0

      - name: Install Linux Podman source-build prerequisites
        run: |
          ${supplyChain.RUNTIME_BUNDLE_UBUNTU_PREREQUISITE_SCRIPT}
`;

  const renderBundleSteps = (cell: PlatformReadinessCell): string => {
    switch (cell.bundleMode) {
      case "current-commit":
        return `${isLinuxCurrentCommit(cell) ? renderLinuxSourceBuildPrereqs() : ""}
      - name: Assemble current-commit ${cell.bundleKey} runtime bundle
        run: bun run scripts/assemble-runtime-bundle.ts --platform ${cell.bundleKey}

      - name: Build local runtime bundle manifest
        run: |
          RUNTIME_VERSION="$(bun -e 'import { readRuntimeBundleSources } from "./scripts/runtime-bundle-sources.ts"; process.stdout.write((await readRuntimeBundleSources()).runtimeVersion)')"
          MANIFEST="$(bun run scripts/build-runtime-bundle.ts --local --platform ${cell.bundleKey} --runtime-version "$RUNTIME_VERSION")"
          echo "LANDO_RUNTIME_BUNDLE_MANIFEST=$MANIFEST" >> "$GITHUB_ENV"
`;
      case "published":
      case "none":
        return "";
      default:
        return assertNever(cell.bundleMode);
    }
  };

  const renderLinuxLandoPrereqs = (cell: PlatformReadinessCell): string => {
    if (!isLinuxLando(cell)) return "";
    return `
${landoRootlessPrereqSteps}

      - name: Configure rootless overlay storage
        run: |
          cat > "\${{ runner.temp }}/lando-storage.conf" <<EOF
          [storage]
          driver = "overlay"

          [storage.options.overlay]
          mount_program = "\${{ runner.temp }}/lando-data/runtime/bin/fuse-overlayfs"
          EOF
          echo "CONTAINERS_STORAGE_CONF=\${{ runner.temp }}/lando-storage.conf" >> "$GITHUB_ENV"
`;
  };

  const renderSetupStep = (cell: PlatformReadinessCell, binary: string): string => {
    const command = `${binary} setup ${setupFlags(cell)}`;
    if (!isLinuxLando(cell)) {
      return `      - name: Setup provider
        run: ${command}`;
    }
    return `      - name: Setup provider
        run: |
          export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}"
          mkdir -p "$XDG_RUNTIME_DIR"
          ${command}`;
  };

  return {
    ciPlatformFor,
    renderRunsOn,
    renderCadenceIf,
    isolateRootsStep,
    setupBunSteps,
    derivedSourcesSteps,
    renderCompileStep,
    renderBundleSteps,
    renderLinuxLandoPrereqs,
    renderSetupStep,
  };
};
