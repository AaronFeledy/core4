/**
 * Shared workflow pieces for the in-container helper. One Linux job builds the
 * static Go helper with Lando itself (Docker provider, no host Go) and uploads
 * it; every job that compiles `lando` downloads it before embedding.
 */

export const CONTAINER_HELPER_JOB_ID = "container-helper";
export const CONTAINER_HELPER_ARM64_JOB_ID = "container-helper-arm64";
export const CONTAINER_HELPER_ARTIFACT = "container-helper";

export const renderContainerHelperJob = (): string => `  ${CONTAINER_HELPER_JOB_ID}:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Regenerate derived sources
        run: bun run codegen

      - name: Set up Lando with Docker
        run: bun core/bin/lando.ts setup --yes --provider=docker --skip-install-ca --skip-shell-integration --skip-file-sync

      - name: Build and test the container helper with Lando
        run: |
          bun run scripts/build-container-helper.ts --test
          bun test core/test/container-helper/helper.integration.test.ts

      - name: Upload container helper
        uses: actions/upload-artifact@v6
        with:
          name: ${CONTAINER_HELPER_ARTIFACT}
          path: core/container-helper/dist/
          if-no-files-found: error
          retention-days: 14`;

export const containerHelperDownloadStep = `      - name: Download container helper
        uses: actions/download-artifact@v7
        with:
          name: ${CONTAINER_HELPER_ARTIFACT}
          path: core/container-helper/dist`;

export const renderContainerHelperArm64Job = (): string => `  ${CONTAINER_HELPER_ARM64_JOB_ID}:
    needs: ${CONTAINER_HELPER_JOB_ID}
    runs-on: ubuntu-24.04-arm
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - name: Install dependencies
        run: bun install --frozen-lockfile

${containerHelperDownloadStep}

      - name: Regenerate derived sources
        run: bun run codegen

      - name: Test the arm64 container helper
        run: |
          chmod +x core/container-helper/dist/linux-arm64/lando-container-helper
          bun test core/test/container-helper/helper.integration.test.ts`;
