export interface TestSelection {
  readonly id: string;
  readonly paths: readonly string[];
  readonly ignore?: readonly string[];
  readonly args?: readonly string[];
  readonly unit?: "exclude";
  readonly runner?: "go";
  readonly jobs: readonly { readonly workflow: string; readonly job: string }[];
  readonly needs?: string;
}

export const UNIT_SHARD_COUNT = 3;
export const NIGHTLY_TIER_TESTS = [
  "core/test/scripts/codegen-ci.test.ts",
  "core/test/build/linux-acceptance-criteria-10-14.test.ts",
] as const;
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
  "windows-arm64",
] as const;
const builds = platforms.map((id) => ({ workflow: "ci.yml", job: `build-${id}` }));
const providers = platforms.map((id) => ({
  workflow: "ci.yml",
  job: `provider-integration-${id}${id === "linux-x64" ? "-runner" : ""}`,
}));
const live = [{ workflow: "ci.yml", job: "provider-integration-linux-x64-runner" }] as const;
const helperJobs = [
  "ci.yml",
  "nightly.yml",
  "drupal-journey.yml",
  "rails-journey.yml",
  "install-lifecycle.yml",
  "platform-readiness.yml",
  "provider-matrix.yml",
  "workflow-performance.yml",
].map((workflow) => ({ workflow, job: "container-helper" }));

export const TEST_SELECTIONS = [
  {
    id: "windows-private-file-access",
    paths: ["state-store/test/state-store/private-file-access.test.ts"],
    jobs: [{ workflow: "ci.yml", job: "static-checks-platform" }],
  },
  {
    id: "shell-dialect",
    paths: [
      "engine/test/services/bun-shell-dialect.test.ts",
      "engine/test/services/bun-shell-dialect-conformance.test.ts",
    ],
    jobs: [{ workflow: "ci.yml", job: "static-checks-platform" }],
  },
  {
    id: "process-signals",
    paths: ["core/test/cli/process-signals.test.ts"],
    jobs: [{ workflow: "ci.yml", job: "process-signal-tests-darwin" }],
  },
  {
    id: "exec-umask",
    paths: ["container-runtime/test/exec-umask.test.ts"],
    jobs: [{ workflow: "ci.yml", job: "process-signal-tests-darwin" }],
  },
  {
    id: "compiled-opentui",
    paths: ["core/test/build/opentui-compiled-acceptance.test.ts"],
    jobs: builds,
    needs: "Native release binary and real PTY",
  },
  {
    id: "compiled-host-execution",
    paths: ["core/test/build/host-execution-compiled.test.ts"],
    jobs: builds,
    needs: "LANDO_TEST_COMPILED_CLI",
  },
  {
    id: "compiled-renderer-output",
    paths: ["core/test/build/renderer-output-compiled.test.ts", "engine/test/runtime/libc.test.ts"],
    jobs: builds,
    needs: "LANDO_TEST_COMPILED_CLI and native terminal",
  },
  {
    id: "provider-contract-sdk",
    paths: ["sdk/test/contract/provider.test.ts", "sdk/test/contract/service.test.ts"],
    jobs: providers,
  },
  {
    id: "provider-contract-lando",
    paths: [
      "plugins/provider-lando/test/contract.test.ts",
      "plugins/provider-lando/test/contract.integration.test.ts",
    ],
    jobs: providers,
    needs: "LANDO_TEST_PODMAN_SOCKET for live cases",
  },
  {
    id: "provider-contract-docker",
    paths: [
      "plugins/provider-docker/test/contract.test.ts",
      "plugins/provider-docker/test/contract.integration.test.ts",
    ],
    jobs: providers,
    needs: "Docker socket for live cases",
  },
  {
    id: "provider-contract-podman",
    paths: [
      "plugins/provider-podman/test/contract.test.ts",
      "plugins/provider-podman/test/contract.integration.test.ts",
    ],
    jobs: providers,
    needs: "LANDO_TEST_PODMAN_SOCKET for live cases",
  },
  {
    id: "provider-capabilities",
    paths: ["plugins/provider-podman/test/capabilities.test.ts"],
    jobs: providers,
  },
  {
    id: "providers-engine-parity",
    paths: ["container-runtime/test/fake-engine-parity.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_PODMAN_SOCKET",
  },
  {
    id: "providers-core-live",
    paths: ["core/test/live/"],
    jobs: live,
    needs: "Live provider socket and compiled CLI",
  },
  {
    id: "providers-lando",
    paths: ["plugins/provider-lando/test/*.integration.test.ts"],
    jobs: live,
    needs: "Live managed Podman runtime; some cases require native opt-ins",
  },
  {
    id: "providers-docker",
    paths: ["plugins/provider-docker/test/*.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_DOCKER_SOCKET",
  },
  {
    id: "services-lando",
    paths: ["plugins/service-lando/test/*.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_PODMAN_SOCKET; architecture and opt-in prerequisites",
  },
  {
    id: "providers-readiness",
    paths: [
      "core/test/cli/start-readiness.integration.test.ts",
      "core/test/services/provider-gate.integration.test.ts",
    ],
    jobs: live,
    needs: "LANDO_TEST_PODMAN_SOCKET",
  },
  {
    id: "providers-ephemeral-data",
    paths: ["container-runtime/test/ephemeral-data-helpers.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_DOCKER_SOCKET",
  },
  {
    id: "providers-host-reachability",
    paths: ["plugins/provider-podman/test/host-reachability.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_PODMAN_SOCKET",
  },
  {
    id: "providers-listener-observation",
    paths: ["container-runtime/test/listener-observation.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_PODMAN_SOCKET",
  },
  {
    id: "providers-sqlite",
    paths: ["plugins/sql/test/sqlite.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_DOCKER_SOCKET",
  },
  {
    id: "providers-sqlite-integrity",
    paths: ["plugins/sql/test/sqlite-integrity.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_DOCKER_SOCKET",
  },
  {
    id: "providers-sqlite-borrowed-mounts",
    paths: ["plugins/sql/test/sqlite-borrowed-mounts.integration.test.ts"],
    jobs: live,
    needs: "LANDO_TEST_DOCKER_SOCKET",
  },
  {
    id: "library",
    paths: ["core/test/library/", "sdk/test/library/"],
    unit: "exclude",
    jobs: [{ workflow: "ci.yml", job: "library-api-tests-runner" }],
  },
  {
    id: "recipes",
    paths: ["core/test/recipes/", "core/test/cli/init.canonical-recipes.test.ts"],
    unit: "exclude",
    jobs: [{ workflow: "ci.yml", job: "recipe-tests-runner" }],
  },
  {
    id: "docs",
    paths: ["docs/test/"],
    ignore: ["**/*.integration.test.ts"],
    unit: "exclude",
    jobs: [{ workflow: "ci.yml", job: "docs-build" }],
  },
  {
    id: "unit-isolation",
    paths: [
      "core/test/cli/doctor.test.ts",
      "core/test/cli/doctor-report.test.ts",
      "core/test/cli/doctor-plugin-metadata.test.ts",
      "core/test/codegen/guide-scenarios.test.ts",
      "core/test/plugins/bundled.test.ts",
      "plugins/provider-lando/test/plugin-descriptor.test.ts",
      "plugins/provider-lando/test/package.test.ts",
    ],
    jobs: [{ workflow: "ci.yml", job: "test-isolation-linux-x64" }],
  },
  {
    id: "container-helper",
    paths: ["core/test/container-helper/helper.integration.test.ts"],
    jobs: [...helperJobs, { workflow: "ci.yml", job: "container-helper-arm64" }],
    needs: "Real native Go container helper",
  },
  {
    id: "container-helper-go",
    paths: ["core/container-helper/**/*_test.go"],
    runner: "go",
    jobs: helperJobs,
    needs: "Containerized Go helper builder",
  },
  {
    id: "nightly-file-sync",
    paths: ["plugins/file-sync-mutagen/test/contract.test.ts"],
    jobs: ["linux-x64", "darwin-arm64", "darwin-x64", "windows-x64"].map((id) => ({
      workflow: "nightly.yml",
      job: `file-sync-contract-${id}`,
    })),
    needs: "LANDO_TEST_FILE_SYNC_LIVE=1",
  },
  {
    id: "nightly-provider-e2e",
    paths: ["core/test/live/", "plugins/service-lando/test/service-identity.live.integration.test.ts"],
    jobs: [{ workflow: "nightly.yml", job: "provider-lando-e2e-linux-x64" }],
    needs: "Live managed Podman and compiled CLI",
  },
  {
    id: "nightly-tier",
    paths: NIGHTLY_TIER_TESTS,
    unit: "exclude",
    jobs: [{ workflow: "nightly.yml", job: "nightly-tier-unit-tests-linux-x64" }],
  },
  {
    id: "mysql-arm-client",
    paths: ["plugins/service-lando/test/mysql-arm-client.integration.test.ts"],
    jobs: [{ workflow: "nightly.yml", job: "mysql-arm-client-linux-arm64" }],
    needs: "LANDO_TEST_MYSQL_ARM64_PODMAN and native ARM64",
  },
  {
    id: "source-store-acceptance",
    paths: ["core/test/build/source-store-acceptance.integration.test.ts"],
    jobs: ["linux-x64", "darwin-arm64", "windows-x64"].map((id) => ({
      workflow: "nightly.yml",
      job: `source-store-acceptance-${id}`,
    })),
    needs: "LANDO_TEST_COMPILED_CLI and git",
  },
  {
    id: "nightly-service-listeners",
    paths: ["plugins/service-lando/test/service-listener-journeys.integration.test.ts"],
    args: ["--max-concurrency=1"],
    jobs: [{ workflow: "nightly.yml", job: "service-listeners-linux-x64" }],
    needs: "LANDO_TEST_LISTENERS_STRICT=1 and live socket",
  },
  {
    id: "nightly-listener-matrix",
    paths: ["plugins/service-lando/test/listener-matrix.integration.test.ts"],
    args: ["--max-concurrency=1"],
    jobs: [{ workflow: "nightly.yml", job: "service-listener-matrix-linux-x64" }],
    needs: "LANDO_TEST_LISTENER_MATRIX_STRICT=1 and live socket",
  },
  {
    id: "tomcat-bump",
    paths: [
      "plugins/service-lando/test/tomcat.test.ts",
      "plugins/service-lando/test/tomcat-port.test.ts",
      "core/test/scripts/tomcat-update.test.ts",
      "core/test/scripts/tomcat-catalog.test.ts",
      "core/test/build/tomcat-bump-workflow.test.ts",
    ],
    jobs: [{ workflow: "tomcat-bump.yml", job: "bump" }],
  },
] as const satisfies readonly TestSelection[];

export type TestSelectionId = (typeof TEST_SELECTIONS)[number]["id"];
export const testSelectionCommand = (id: TestSelectionId): string => `bun run test:selection ${id}`;

export const selectorMatches = (selector: string, path: string): boolean =>
  selector.endsWith("/") ? path.startsWith(selector) : new Bun.Glob(selector).match(path);

export const selectionMatches = (selection: TestSelection, path: string): boolean =>
  selection.paths.some((selector) => selectorMatches(selector, path)) &&
  !(selection.ignore ?? []).some((selector) => selectorMatches(selector, path));
