export type ProviderAcceptanceCellId =
  | "docker-desktop-macos"
  | "docker-engine-linux"
  | "lando-machine-macos"
  | "lando-machine-windows"
  | "podman-desktop-macos"
  | "podman-machine-macos"
  | "podman-machine-windows"
  | "lando-podman6-linux"
  | "podman-podman6-linux"
  | "lima-macos"
  | "orbstack-macos";

export type ProviderId = "docker" | "podman" | "lando";

export interface ProviderAcceptanceCheckPlan {
  readonly id: string;
  readonly label: string;
  readonly command: readonly string[];
}

export interface ProviderAcceptanceCellPlan {
  readonly id: ProviderAcceptanceCellId;
  readonly engine: string;
  readonly runsOn: string;
  readonly provider: ProviderId;
  readonly releaseBlocking: boolean;
  readonly installPodman6: boolean;
  readonly setup: "advisory" | "docker-engine" | "managed-lando" | "homebrew-podman" | "machine-lifecycle";
  readonly requiredEnv?: string;
  readonly requiredEnvValue?: string;
  readonly requiredCommand?: {
    readonly env: string;
    readonly defaultValue: string;
    readonly label: string;
  };
  readonly advisorySkipReason?: string;
  readonly checks: readonly ProviderAcceptanceCheckPlan[];
}

const bunTest = (path: string, testNamePattern?: string): readonly string[] =>
  testNamePattern === undefined
    ? ["bun", "test", path]
    : ["bun", "test", path, "--test-name-pattern", testNamePattern];

const landoChecks = [
  {
    id: "managed-setup-readiness",
    label: "Managed setup/readiness gates",
    command: bunTest("plugins/provider-lando/test/setup-version-gate.test.ts"),
  },
  {
    id: "sdk-provider-contract",
    label: "SDK provider contract against live Podman socket",
    command: bunTest(
      "plugins/provider-lando/test/contract.integration.test.ts",
      "passes the SDK provider contract suite against a live Podman socket",
    ),
  },
  {
    id: "lando-bring-up",
    label: "Apply/start lifecycle seam coverage through provider-lando fake API",
    command: bunTest(
      "plugins/provider-lando/test/bring-up.integration.test.ts",
      "RuntimeProvider apply delegates to bringUp",
    ),
  },
  {
    id: "lando-bring-down",
    label: "Stop/destroy lifecycle coverage through provider-lando",
    command: bunTest("plugins/provider-lando/test/bring-down.integration.test.ts"),
  },
  {
    id: "lando-exec",
    label: "Exec seam coverage through provider-lando fake API",
    command: bunTest("plugins/provider-lando/test/exec.integration.test.ts"),
  },
  {
    id: "lando-logs",
    label: "Logs seam coverage through provider-lando fake API",
    command: bunTest("plugins/provider-lando/test/logs.integration.test.ts"),
  },
  {
    id: "lando-inspect-health",
    label: "Health/readiness seam coverage through provider-lando fake API",
    command: bunTest("plugins/provider-lando/test/inspect-health.test.ts"),
  },
  {
    id: "lando-image-resolution-pull",
    label: "Image pull seam coverage through provider-lando fake API",
    command: bunTest("plugins/provider-lando/test/image-pull.test.ts"),
  },
  {
    id: "lando-volume-cleanup",
    label: "Volume cleanup seam coverage through provider-lando fake API",
    command: bunTest("plugins/provider-lando/test/volume-prune.test.ts"),
  },
] as const satisfies readonly ProviderAcceptanceCheckPlan[];

const podmanChecks = [
  {
    id: "sdk-provider-contract",
    label: "SDK provider contract against live Podman socket",
    command: bunTest(
      "plugins/provider-podman/test/contract.integration.test.ts",
      "passes the SDK provider contract suite against a live Podman socket",
    ),
  },
  {
    id: "podman-capabilities",
    label: "Podman provider capability declaration",
    command: bunTest("plugins/provider-podman/test/capabilities.test.ts"),
  },
] as const satisfies readonly ProviderAcceptanceCheckPlan[];

const dockerChecks = [
  {
    id: "sdk-provider-contract",
    label: "SDK provider contract against live Docker Engine socket",
    command: bunTest(
      "plugins/provider-docker/test/contract.integration.test.ts",
      "runs the provider contract suite against a live Docker Engine socket",
    ),
  },
] as const satisfies readonly ProviderAcceptanceCheckPlan[];

export const PROVIDER_ACCEPTANCE_CELLS: readonly ProviderAcceptanceCellPlan[] = [
  {
    id: "docker-desktop-macos",
    engine: "Docker Desktop",
    runsOn: "macos-15",
    provider: "docker",
    releaseBlocking: false,
    installPodman6: false,
    setup: "advisory",
    advisorySkipReason:
      "Docker Desktop requires a licensed desktop app and is not installed on GitHub-hosted macOS runners.",
    checks: [],
  },
  {
    id: "docker-engine-linux",
    engine: "Docker Engine",
    runsOn: "ubuntu-24.04",
    provider: "docker",
    releaseBlocking: true,
    installPodman6: false,
    setup: "docker-engine",
    requiredEnv: "LANDO_TEST_DOCKER_SOCKET",
    checks: dockerChecks,
  },
  {
    id: "podman-desktop-macos",
    engine: "Podman Desktop",
    runsOn: "macos-15",
    provider: "podman",
    releaseBlocking: false,
    installPodman6: false,
    setup: "advisory",
    advisorySkipReason:
      "Podman Desktop is not installable in GitHub-hosted CI; run this cell on a prepared self-hosted runner.",
    checks: [],
  },
  ...MACHINE_LIFECYCLE_ACCEPTANCE_CELLS,
  {
    id: "lando-podman6-linux",
    engine: "Lando managed Podman 6",
    runsOn: "ubuntu-24.04",
    provider: "lando",
    releaseBlocking: true,
    installPodman6: false,
    setup: "managed-lando",
    requiredEnv: "LANDO_TEST_PODMAN_SOCKET",
    checks: landoChecks,
  },
  {
    id: "podman-podman6-linux",
    engine: "Podman 6",
    runsOn: "ubuntu-24.04",
    provider: "podman",
    releaseBlocking: true,
    installPodman6: true,
    setup: "homebrew-podman",
    requiredEnv: "LANDO_TEST_PODMAN_SOCKET",
    checks: podmanChecks,
  },
  {
    id: "lima-macos",
    engine: "Lima",
    runsOn: "macos-15",
    provider: "docker",
    releaseBlocking: false,
    installPodman6: false,
    setup: "advisory",
    advisorySkipReason:
      "Lima provider coverage needs a prepared macOS runtime; GitHub-hosted runners do not ship a reusable Lima daemon.",
    checks: [],
  },
  {
    id: "orbstack-macos",
    engine: "OrbStack",
    runsOn: "macos-15",
    provider: "docker",
    releaseBlocking: false,
    installPodman6: false,
    setup: "advisory",
    advisorySkipReason: "OrbStack is a macOS desktop runtime and is not installable in GitHub-hosted CI.",
    checks: [],
  },
] as const;

export class UnknownProviderAcceptanceCellError extends Error {
  constructor(readonly cellId: string) {
    super(`Unknown provider acceptance cell: ${cellId}`);
    this.name = "UnknownProviderAcceptanceCellError";
  }
}

export const buildProviderAcceptancePlan = (cellId: ProviderAcceptanceCellId): ProviderAcceptanceCellPlan => {
  const cell = PROVIDER_ACCEPTANCE_CELLS.find((candidate) => candidate.id === cellId);
  if (cell === undefined) throw new UnknownProviderAcceptanceCellError(cellId);
  return cell;
};
import { MACHINE_LIFECYCLE_ACCEPTANCE_CELLS } from "./provider-machine-lifecycle-plan.ts";
