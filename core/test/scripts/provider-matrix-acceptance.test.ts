import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type ProviderAcceptanceCellId =
  | "docker-desktop-macos"
  | "docker-engine-linux"
  | "podman-podman6-linux"
  | "lando-podman6-linux";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProviderAcceptanceCheck {
  readonly id: string;
  readonly label: string;
  readonly outcome: "passed" | "failed";
  readonly command: readonly string[];
  readonly evidence: {
    readonly id: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
}

interface ProviderAcceptanceReport {
  readonly cellId: string;
  readonly outcome: "passed" | "failed" | "skipped";
  readonly releaseBlocking: boolean;
  readonly checks: readonly ProviderAcceptanceCheck[];
  readonly skip?: { readonly kind: string; readonly reason: string; readonly blocksRelease: boolean };
}

interface AcceptanceModule {
  readonly buildProviderAcceptancePlan: (cellId: ProviderAcceptanceCellId) => unknown;
  readonly evaluateProviderAcceptanceReport: (report: unknown) => {
    readonly exitCode: 0 | 1;
    readonly reason: string;
  };
  readonly preflightProviderAcceptanceCell: (input: {
    readonly cell: unknown;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    readonly isSocket: (path: string) => boolean;
  }) => { readonly available: boolean; readonly reason?: string };
  readonly runProviderAcceptanceCell: (input: {
    readonly cell: unknown;
    readonly runCommand: (command: readonly string[]) => Promise<CommandResult>;
    readonly prerequisites?: { readonly available: boolean; readonly reason?: string };
  }) => Promise<ProviderAcceptanceReport>;
  readonly writeProviderAcceptanceReport: (input: {
    readonly report: ProviderAcceptanceReport;
    readonly path: string;
  }) => Promise<void>;
}

class AcceptanceModuleShapeError extends Error {
  constructor() {
    super("Provider acceptance module did not expose the expected test seam.");
    this.name = "AcceptanceModuleShapeError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const acceptanceModuleKeys = [
  "buildProviderAcceptancePlan",
  "evaluateProviderAcceptanceReport",
  "preflightProviderAcceptanceCell",
  "runProviderAcceptanceCell",
  "writeProviderAcceptanceReport",
] as const satisfies readonly (keyof AcceptanceModule)[];

const isAcceptanceModule = (value: unknown): value is AcceptanceModule =>
  isRecord(value) && acceptanceModuleKeys.every((key) => typeof value[key] === "function");

const loadAcceptanceModule = async (): Promise<AcceptanceModule> => {
  const moduleUrl = new URL("../../../scripts/provider-matrix-acceptance.ts", import.meta.url);
  const loaded: unknown = await import(moduleUrl.href);
  if (!isAcceptanceModule(loaded)) throw new AcceptanceModuleShapeError();
  return loaded;
};

const {
  buildProviderAcceptancePlan,
  evaluateProviderAcceptanceReport,
  preflightProviderAcceptanceCell,
  runProviderAcceptanceCell,
  writeProviderAcceptanceReport,
} = await loadAcceptanceModule();

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "provider-matrix-acceptance-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

const success = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

const resultFor =
  (failCheckId: string | undefined) =>
  (command: readonly string[]): Promise<CommandResult> => {
    const commandText = command.join(" ");
    if (failCheckId !== undefined && commandText.includes(failCheckId)) {
      return Promise.resolve({ exitCode: 7, stdout: "partial", stderr: "boom" });
    }
    return Promise.resolve(success(`ok ${commandText}`));
  };

const readReport = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

describe("provider matrix acceptance reporting", () => {
  test("provider matrix runner records a passing release-blocking Linux cell", async () => {
    const cellId: ProviderAcceptanceCellId = "lando-podman6-linux";

    const report = await runProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan(cellId),
      runCommand: resultFor(undefined),
    });

    expect(report).toMatchObject({
      cellId,
      outcome: "passed",
      releaseBlocking: true,
    });
    expect(report.skip).toBeUndefined();
    expect(report.checks.map((check) => check.id)).toEqual([
      "managed-setup-readiness",
      "sdk-provider-contract",
      "lando-bring-up",
      "lando-bring-down",
      "lando-exec",
      "lando-logs",
      "lando-inspect-health",
      "lando-image-resolution-pull",
      "lando-volume-cleanup",
    ]);
    expect(report.checks.every((check) => check.outcome === "passed")).toBe(true);
    expect(report.checks.every((check) => check.evidence.id.startsWith(`${cellId}.`))).toBe(true);
    expect(report.checks.find((check) => check.id === "sdk-provider-contract")?.command).toEqual([
      "bun",
      "test",
      "plugins/provider-lando/test/contract.integration.test.ts",
      "--test-name-pattern",
      "passes the SDK provider contract suite against a live Podman socket",
    ]);
    expect(report.checks.find((check) => check.id === "lando-image-resolution-pull")?.label).toBe(
      "Image pull seam coverage through provider-lando fake API",
    );
    expect(evaluateProviderAcceptanceReport(report).exitCode).toBe(0);
  });

  test("provider matrix runner preflights required sockets before running commands", async () => {
    const missing = preflightProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("podman-podman6-linux"),
      env: { LANDO_TEST_PODMAN_SOCKET: "/tmp/missing-podman.sock" },
      platform: "linux",
      isSocket: () => false,
    });
    const present = preflightProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("docker-engine-linux"),
      env: { LANDO_TEST_DOCKER_SOCKET: "/var/run/docker.sock" },
      platform: "linux",
      isSocket: (path) => path === "/var/run/docker.sock",
    });

    expect(missing).toMatchObject({ available: false });
    expect(missing.reason).toContain("/tmp/missing-podman.sock");
    expect(present).toEqual({ available: true });
  });

  test("provider matrix runner reports unsupported platforms and normalizes Docker socket URLs", () => {
    const unsupported = preflightProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("lando-podman6-linux"),
      env: { LANDO_TEST_PODMAN_SOCKET: "/tmp/podman.sock" },
      platform: "darwin",
      isSocket: () => true,
    });
    const empty = preflightProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("podman-podman6-linux"),
      env: { LANDO_TEST_PODMAN_SOCKET: "" },
      platform: "linux",
      isSocket: () => true,
    });
    const docker = preflightProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("docker-engine-linux"),
      env: { LANDO_TEST_DOCKER_SOCKET: "unix:///var/run/docker.sock" },
      platform: "linux",
      isSocket: (path) => path === "/var/run/docker.sock",
    });

    expect(unsupported).toEqual({
      available: false,
      reason: "lando-podman6-linux requires linux, received darwin.",
    });
    expect(empty).toEqual({ available: false, reason: "LANDO_TEST_PODMAN_SOCKET was not set." });
    expect(docker).toEqual({ available: true });
  });

  test("provider matrix runner records missing prerequisites as a structured skip", async () => {
    const blockingReport = await runProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("podman-podman6-linux"),
      prerequisites: { available: false, reason: "LANDO_TEST_PODMAN_SOCKET was not set" },
      runCommand: resultFor(undefined),
    });
    const advisoryReport = await runProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("docker-desktop-macos"),
      runCommand: resultFor(undefined),
    });

    expect(blockingReport).toMatchObject({
      outcome: "skipped",
      releaseBlocking: true,
      skip: { kind: "missing-prerequisite", blocksRelease: true },
    });
    expect(blockingReport.skip?.reason).toContain("LANDO_TEST_PODMAN_SOCKET");
    expect(advisoryReport).toMatchObject({
      outcome: "skipped",
      releaseBlocking: false,
      skip: { kind: "advisory", blocksRelease: false },
    });
    expect(advisoryReport.skip?.reason.length).toBeGreaterThan(0);
    expect(evaluateProviderAcceptanceReport(blockingReport).exitCode).toBe(1);
    expect(evaluateProviderAcceptanceReport(advisoryReport).exitCode).toBe(0);
  });

  test("provider matrix runner preserves failed check evidence", async () => {
    const report = await runProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("docker-engine-linux"),
      runCommand: resultFor("provider-docker"),
    });

    expect(report).toMatchObject({ outcome: "failed", releaseBlocking: true });
    expect(report.checks.find((check) => check.id === "sdk-provider-contract")).toMatchObject({
      outcome: "failed",
      command: [
        "bun",
        "test",
        "plugins/provider-docker/test/contract.integration.test.ts",
        "--test-name-pattern",
        "runs the provider contract suite against a live Docker Engine socket",
      ],
      evidence: { exitCode: 7, stdout: "partial", stderr: "boom" },
    });
    expect(evaluateProviderAcceptanceReport(report).exitCode).toBe(1);
  });

  test("provider matrix evaluation rejects unexpected outcomes", () => {
    const report = {
      schemaVersion: 1,
      cellId: "docker-engine-linux",
      provider: "docker",
      engine: "Docker Engine",
      runsOn: "ubuntu-24.04",
      releaseBlocking: true,
      outcome: "cancelled",
      checks: [],
    };

    expect(() => evaluateProviderAcceptanceReport(report)).toThrow(
      "Unexpected provider acceptance outcome: cancelled",
    );
  });

  test("provider matrix runner writes uploadable JSON before blocking evaluation", async () => {
    const report = await runProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan("podman-podman6-linux"),
      prerequisites: { available: false, reason: "podman socket absent" },
      runCommand: resultFor(undefined),
    });
    const path = join(tempDir, "podman-podman6-linux.json");

    await writeProviderAcceptanceReport({ report, path });

    expect(await readReport(path)).toMatchObject({
      cellId: "podman-podman6-linux",
      outcome: "skipped",
      skip: { reason: "podman socket absent", blocksRelease: true },
    });
    expect(evaluateProviderAcceptanceReport(report).exitCode).toBe(1);
  });
});
