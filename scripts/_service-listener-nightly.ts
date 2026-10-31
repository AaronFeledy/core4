import { CONTAINER_HELPER_JOB_ID, containerHelperDownloadStep } from "./_container-helper-workflow.ts";
import { isolateLandoRootsStep } from "./_lando-roots-workflow.ts";
import { landoRootlessPrereqSteps } from "./build-ci-workflow.ts";
import { LINUX_X64_TEST_RUNNER } from "./ci-platforms.ts";
import { renderAssertPodman6Step, renderInstallPodman6Step } from "./ci-podman-install.ts";

export const serviceListenerNightlyJob = `
  service-listeners-linux-x64:
    needs: [${CONTAINER_HELPER_JOB_ID}]
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

${renderInstallPodman6Step()}

${renderAssertPodman6Step()}

${landoRootlessPrereqSteps}

      - name: Start explicit listener test socket
        run: |
          socket="$RUNNER_TEMP/listener-podman.sock"
          podman system service --time=0 "unix://$socket" > "$RUNNER_TEMP/listener-podman.log" 2>&1 &
          echo "$!" > "$RUNNER_TEMP/listener-podman.pid"
          for i in {1..30}; do test -S "$socket" && break; sleep 1; done
          curl --fail --max-time 5 --unix-socket "$socket" http://localhost/_ping
          echo "LANDO_TEST_PODMAN_SOCKET=$socket" >> "$GITHUB_ENV"

      - name: Build test-only pinned MinIO BYO image
        run: bun scripts/build-service-listener-qa-image.ts "$LANDO_TEST_MINIO_IMAGE"

      - name: Compile current listener CLI
        run: |
          bun run --filter='@lando/core' build:manifest
          bun run scripts/build-compiled-binary.ts --target bun-linux-x64 --outfile ./core/dist/lando --version 0.0.0-listener-qa --minify --sourcemap=external
          bun run scripts/sanitize-compiled-binary.ts ./core/dist/lando
          ./core/dist/lando --version
          echo "LANDO_SCENARIO_E2E_BINARY=$GITHUB_WORKSPACE/core/dist/lando" >> "$GITHUB_ENV"

      - name: Require all four serial real-service journeys
        shell: bash
        run: |
          set -euo pipefail
          bun test plugins/service-lando/test/service-listener-journeys.integration.test.ts --max-concurrency=1 2>&1 | tee "$RUNNER_TEMP/listener-acceptance.log"
          grep -E '^SERVICE_LISTENER_ACCEPTANCE completed=4/4 cases=' "$RUNNER_TEMP/listener-acceptance.log"

      - name: Stop listener test socket
        if: always()
        run: |
          if test -f "$RUNNER_TEMP/listener-podman.pid"; then kill "$(cat "$RUNNER_TEMP/listener-podman.pid")"; fi

      - name: Upload listener diagnostics
        if: always()
        uses: actions/upload-artifact@v6
        with:
          name: service-listener-acceptance-linux-x64
          path: |
            \${{ runner.temp }}/listener-acceptance.log
            \${{ runner.temp }}/listener-podman.log
          if-no-files-found: warn
          retention-days: 7`;
