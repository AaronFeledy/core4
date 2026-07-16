import { describe, expect, test } from "bun:test";

interface ProviderAcceptanceCellPlan {
  readonly id: string;
  readonly runsOn: string;
  readonly provider: string;
  readonly releaseBlocking: boolean;
  readonly checks: readonly { readonly id: string }[];
}

interface ProviderAcceptanceReport {
  readonly cellId: string;
  readonly releaseBlocking: boolean;
  readonly outcome: "passed" | "failed" | "skipped";
  readonly checks: readonly unknown[];
  readonly skip?: unknown;
}

interface AcceptanceModule {
  readonly PROVIDER_ACCEPTANCE_CELLS: readonly ProviderAcceptanceCellPlan[];
  readonly evaluateProviderAcceptanceReport: (report: ProviderAcceptanceReport) => {
    readonly exitCode: 0 | 1;
    readonly reason: string;
  };
  readonly preflightProviderAcceptanceCell: (input: {
    readonly cell: ProviderAcceptanceCellPlan;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    readonly isSocket: (path: string) => boolean;
    readonly isCommand?: (command: string) => boolean;
  }) => { readonly available: boolean; readonly reason?: string };
  readonly runProviderAcceptanceCell: (input: {
    readonly cell: ProviderAcceptanceCellPlan;
    readonly prerequisites: { readonly available: boolean };
    readonly runCommand: (command: readonly string[]) => Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>;
  }) => Promise<ProviderAcceptanceReport>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAcceptanceModule = (value: unknown): value is AcceptanceModule =>
  isRecord(value) &&
  Array.isArray(value.PROVIDER_ACCEPTANCE_CELLS) &&
  typeof value.evaluateProviderAcceptanceReport === "function" &&
  typeof value.preflightProviderAcceptanceCell === "function" &&
  typeof value.runProviderAcceptanceCell === "function";

class AcceptanceModuleShapeError extends Error {
  constructor() {
    super("Provider acceptance module has an unexpected shape.");
    this.name = "AcceptanceModuleShapeError";
  }
}

const loaded: unknown = await import(
  new URL("../../../scripts/provider-matrix-acceptance.ts", import.meta.url).href
);
if (!isAcceptanceModule(loaded)) throw new AcceptanceModuleShapeError();
const {
  PROVIDER_ACCEPTANCE_CELLS,
  evaluateProviderAcceptanceReport,
  preflightProviderAcceptanceCell,
  runProviderAcceptanceCell,
} = loaded;

const machineCellIds = [
  "lando-machine-macos",
  "lando-machine-windows",
  "podman-machine-macos",
  "podman-machine-windows",
] as const;

class MissingMachineCellError extends Error {
  constructor(readonly cellId: string) {
    super(`Missing machine lifecycle acceptance cell: ${cellId}`);
    this.name = "MissingMachineCellError";
  }
}

const requireCell = (cellId: string): ProviderAcceptanceCellPlan => {
  const cell = PROVIDER_ACCEPTANCE_CELLS.find((candidate) => candidate.id === cellId);
  if (cell === undefined) throw new MissingMachineCellError(cellId);
  return cell;
};

describe("provider machine lifecycle acceptance", () => {
  test("declares advisory managed and system lifecycle cells for macOS and Windows", () => {
    const cells = machineCellIds.map(requireCell);

    expect(cells.map((cell) => cell.runsOn)).toEqual([
      "macos-15",
      "windows-2022",
      "macos-15",
      "windows-2022",
    ]);
    expect(cells.map((cell) => cell.provider)).toEqual(["lando", "lando", "podman", "podman"]);
    expect(cells.every((cell) => !cell.releaseBlocking)).toBe(true);
    expect(cells.every((cell) => cell.checks.map((check) => check.id).includes("machine-lifecycle"))).toBe(
      true,
    );
  });

  test("requires an exact lifecycle opt-in before running a native host cell", () => {
    const cell = requireCell("lando-machine-macos");
    const input = {
      cell,
      platform: "darwin" as const,
      isSocket: () => false,
      isCommand: () => true,
    };

    const absent = preflightProviderAcceptanceCell({ ...input, env: {} });
    const malformed = preflightProviderAcceptanceCell({
      ...input,
      env: { LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE: "yes" },
    });
    const enabled = preflightProviderAcceptanceCell({
      ...input,
      env: { LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE: "1" },
    });

    expect(absent).toEqual({
      available: false,
      reason: "LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE=1 is required.",
    });
    expect(malformed).toEqual(absent);
    expect(enabled).toEqual({ available: true });
  });

  test("structured-skips an opted-in cell when machine tooling is absent", () => {
    const unavailable = preflightProviderAcceptanceCell({
      cell: requireCell("podman-machine-windows"),
      env: { LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE: "1" },
      platform: "win32",
      isSocket: () => false,
      isCommand: () => false,
    });

    expect(unavailable).toEqual({
      available: false,
      reason: "Podman machine command was not found.",
    });
  });

  test("records a successful native lifecycle check as passed", async () => {
    const report = await runProviderAcceptanceCell({
      cell: requireCell("lando-machine-macos"),
      prerequisites: { available: true },
      runCommand: () => Promise.resolve({ exitCode: 0, stdout: "lifecycle complete", stderr: "" }),
    });

    expect(report).toMatchObject({
      cellId: "lando-machine-macos",
      releaseBlocking: false,
      outcome: "passed",
      checks: [{ id: "machine-lifecycle", outcome: "passed", evidence: { exitCode: 0 } }],
    });
    expect(report.skip).toBeUndefined();
  });

  test("records a claimed lifecycle command failure instead of passing or skipping it", async () => {
    const report = await runProviderAcceptanceCell({
      cell: requireCell("podman-machine-windows"),
      prerequisites: { available: true },
      runCommand: (command) =>
        Promise.resolve({ exitCode: 9, stdout: "partial lifecycle", stderr: command.join(" ") }),
    });

    expect(report).toMatchObject({
      cellId: "podman-machine-windows",
      releaseBlocking: false,
      outcome: "failed",
      checks: [{ id: "machine-lifecycle", outcome: "failed", evidence: { exitCode: 9 } }],
    });
    expect(report.skip).toBeUndefined();
    expect(evaluateProviderAcceptanceReport(report)).toEqual({ exitCode: 0, reason: "advisory cell" });
  });

  test("preserves the release-blocking Linux provider cells", () => {
    const linuxCells = ["docker-engine-linux", "lando-podman6-linux", "podman-podman6-linux"].map(
      requireCell,
    );

    expect(linuxCells.every((cell) => cell.releaseBlocking)).toBe(true);
    expect(linuxCells.every((cell) => cell.runsOn === "ubuntu-24.04")).toBe(true);
  });
});
