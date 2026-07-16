import type { ProviderAcceptanceCellPlan, ProviderAcceptanceCheckPlan } from "./provider-matrix-plan.ts";

const bunTest = (testNamePattern: string): readonly string[] => [
  "bun",
  "test",
  "plugins/provider-lando/test/machine-lifecycle-live.integration.test.ts",
  "--test-name-pattern",
  testNamePattern,
];

const managedMachineChecks = [
  {
    id: "machine-lifecycle",
    label: "Managed Podman machine start, stop, restart, and destroy",
    command: bunTest("managed machine start stop destroy"),
  },
] as const satisfies readonly ProviderAcceptanceCheckPlan[];

const systemMachineChecks = [
  {
    id: "machine-lifecycle",
    label: "System Podman machine start, stop, restart, and destroy",
    command: bunTest("system Podman machine start stop destroy"),
  },
] as const satisfies readonly ProviderAcceptanceCheckPlan[];

const podmanMachineCommand = {
  env: "LANDO_TEST_PODMAN_COMMAND",
  defaultValue: "podman",
  label: "Podman machine command",
} as const;

export const MACHINE_LIFECYCLE_ACCEPTANCE_CELLS = [
  {
    id: "lando-machine-macos",
    engine: "Lando managed Podman machine on macOS",
    runsOn: "macos-15",
    provider: "lando",
    releaseBlocking: false,
    installPodman6: false,
    setup: "machine-lifecycle",
    requiredEnv: "LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE",
    requiredEnvValue: "1",
    requiredCommand: podmanMachineCommand,
    checks: managedMachineChecks,
  },
  {
    id: "lando-machine-windows",
    engine: "Lando managed Podman machine on Windows",
    runsOn: "windows-2022",
    provider: "lando",
    releaseBlocking: false,
    installPodman6: false,
    setup: "machine-lifecycle",
    requiredEnv: "LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE",
    requiredEnvValue: "1",
    requiredCommand: podmanMachineCommand,
    checks: managedMachineChecks,
  },
  {
    id: "podman-machine-macos",
    engine: "System Podman machine on macOS",
    runsOn: "macos-15",
    provider: "podman",
    releaseBlocking: false,
    installPodman6: false,
    setup: "machine-lifecycle",
    requiredEnv: "LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE",
    requiredEnvValue: "1",
    requiredCommand: podmanMachineCommand,
    checks: systemMachineChecks,
  },
  {
    id: "podman-machine-windows",
    engine: "System Podman machine on Windows",
    runsOn: "windows-2022",
    provider: "podman",
    releaseBlocking: false,
    installPodman6: false,
    setup: "machine-lifecycle",
    requiredEnv: "LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE",
    requiredEnvValue: "1",
    requiredCommand: podmanMachineCommand,
    checks: systemMachineChecks,
  },
] as const satisfies readonly ProviderAcceptanceCellPlan[];
