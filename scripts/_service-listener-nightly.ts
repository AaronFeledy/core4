import { CONTAINER_HELPER_JOB_ID, containerHelperDownloadStep } from "./_container-helper-workflow.ts";
import { isolateLandoRootsStep } from "./_lando-roots-workflow.ts";
import { landoManagedPodmanTeardownCommands, linuxGuideE2eProviderSetupSteps } from "./build-ci-workflow.ts";
import { LINUX_X64_TEST_RUNNER } from "./ci-platforms.ts";

export const serviceListenerNightlyJob = `
  service-listeners-linux-x64:
    needs: [${CONTAINER_HELPER_JOB_ID}, runtime-bundle-linux-x64]
    runs-on: ${LINUX_X64_TEST_RUNNER}
    timeout-minutes: 60
    env:
      LANDO_TEST_LISTENERS_STRICT: "1"
      LANDO_TEST_MINIO_IMAGE: localhost/lando-listener-minio:qa
      LANDO_TEST_MAILPIT_IMAGE: docker.io/axllent/mailpit:v1.30.1
      LANDO_TEST_LISTENER_CLIENT_IMAGE: docker.io/library/alpine:3.21
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
${isolateLandoRootsStep}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - name: Install dependencies
        run: bun install --frozen-lockfile

${containerHelperDownloadStep}

      - name: Regenerate derived sources
        run: bun run codegen

      - name: Compile current listener CLI
        run: |
          mkdir -p dist
          bun run --filter='@lando/core' build:manifest
          VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "0.0.0-dev")
          bun run scripts/build-compiled-binary.ts --target bun-linux-x64 --outfile ./dist/lando --version "$VERSION" --minify --sourcemap=external
          bun run scripts/sanitize-compiled-binary.ts ./dist/lando
          ./dist/lando --version
          echo "LANDO_SCENARIO_E2E_BINARY=$GITHUB_WORKSPACE/dist/lando" >> "$GITHUB_ENV"

${linuxGuideE2eProviderSetupSteps}

      - name: Build test-only pinned MinIO BYO image
        run: bun scripts/build-service-listener-qa-image.ts "$LANDO_TEST_MINIO_IMAGE"

      - name: Require all four serial real-service journeys
        shell: bash
        run: |
          set -euo pipefail
          bun test plugins/service-lando/test/service-listener-journeys.integration.test.ts --max-concurrency=1 2>&1 | tee "$RUNNER_TEMP/listener-acceptance.log"
          grep -E '^SERVICE_LISTENER_ACCEPTANCE completed=4/4 cases=' "$RUNNER_TEMP/listener-acceptance.log"

      - name: Teardown Lando runtime
        if: always()
        run: |
          dist/lando poweroff || true
${landoManagedPodmanTeardownCommands}

      - name: Collect listener diagnostics
        if: always()
        run: |
          mkdir -p service-listener-diagnostics
          dist/lando doctor --format json > service-listener-diagnostics/doctor.json 2>&1 || true
          cp "$LANDO_USER_DATA_ROOT/runtime/run/service.log" service-listener-diagnostics/podman-service.log || true
          cp -r "$LANDO_USER_CACHE_ROOT/logs" service-listener-diagnostics/lando-logs || true
          journalctl --no-pager --since "-30 minutes" > service-listener-diagnostics/journalctl.log 2>&1 || true

      - name: Upload listener diagnostics
        if: always()
        uses: actions/upload-artifact@v6
        with:
          name: service-listener-acceptance-linux-x64
          path: |
            \${{ runner.temp }}/listener-acceptance.log
            service-listener-diagnostics
            provider-diagnostics
          if-no-files-found: warn
          retention-days: 7`;
