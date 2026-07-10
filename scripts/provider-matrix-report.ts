import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProviderAcceptanceCellPlan, ProviderAcceptanceCheckPlan } from "./provider-matrix-plan.ts";

export type ProviderAcceptanceOutcome = "passed" | "failed" | "skipped";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProviderAcceptanceEvidence {
  readonly id: string;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProviderAcceptanceCheckReport {
  readonly id: string;
  readonly label: string;
  readonly outcome: Exclude<ProviderAcceptanceOutcome, "skipped">;
  readonly command: readonly string[];
  readonly evidence: ProviderAcceptanceEvidence;
}

export interface ProviderAcceptanceSkip {
  readonly kind: "advisory" | "missing-prerequisite";
  readonly reason: string;
  readonly blocksRelease: boolean;
}

export interface ProviderAcceptanceReport {
  readonly schemaVersion: 1;
  readonly cellId: string;
  readonly provider: string;
  readonly engine: string;
  readonly runsOn: string;
  readonly releaseBlocking: boolean;
  readonly outcome: ProviderAcceptanceOutcome;
  readonly checks: readonly ProviderAcceptanceCheckReport[];
  readonly skip?: ProviderAcceptanceSkip;
}

export interface ProviderAcceptancePrerequisites {
  readonly available: boolean;
  readonly reason?: string;
}

export interface ProviderAcceptancePreflightInput {
  readonly cell: ProviderAcceptanceCellPlan;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly isSocket: (path: string) => boolean;
}

export interface RunProviderAcceptanceCellInput {
  readonly cell: ProviderAcceptanceCellPlan;
  readonly runCommand: (command: readonly string[]) => Promise<CommandResult>;
  readonly prerequisites?: ProviderAcceptancePrerequisites;
}

export interface WriteProviderAcceptanceReportInput {
  readonly report: ProviderAcceptanceReport;
  readonly path: string;
}

export interface ProviderAcceptanceEvaluation {
  readonly exitCode: 0 | 1;
  readonly reason: string;
}

const EVIDENCE_LIMIT = 12_000;

const bounded = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

const skippedReport = (
  cell: ProviderAcceptanceCellPlan,
  skip: ProviderAcceptanceSkip,
): ProviderAcceptanceReport => ({
  schemaVersion: 1,
  cellId: cell.id,
  provider: cell.provider,
  engine: cell.engine,
  runsOn: cell.runsOn,
  releaseBlocking: cell.releaseBlocking,
  outcome: "skipped",
  checks: [],
  skip,
});

const checkReport = (
  cell: ProviderAcceptanceCellPlan,
  check: ProviderAcceptanceCheckPlan,
  result: CommandResult,
): ProviderAcceptanceCheckReport => ({
  id: check.id,
  label: check.label,
  outcome: result.exitCode === 0 ? "passed" : "failed",
  command: check.command,
  evidence: {
    id: `${cell.id}.${check.id}`,
    command: check.command,
    exitCode: result.exitCode,
    stdout: bounded(result.stdout),
    stderr: bounded(result.stderr),
  },
});

const missingPrerequisiteSkip = (
  cell: ProviderAcceptanceCellPlan,
  prerequisites: ProviderAcceptancePrerequisites,
): ProviderAcceptanceReport | undefined => {
  if (prerequisites.available) return undefined;
  return skippedReport(cell, {
    kind: "missing-prerequisite",
    reason: prerequisites.reason ?? "Required provider acceptance prerequisite was not available.",
    blocksRelease: cell.releaseBlocking,
  });
};

const requiredPlatformFor = (runsOn: string): NodeJS.Platform | undefined => {
  if (runsOn.startsWith("ubuntu-")) return "linux";
  if (runsOn.startsWith("macos-")) return "darwin";
  if (runsOn.startsWith("windows-")) return "win32";
  return undefined;
};

const dockerSocketPath = (value: string): string =>
  value.startsWith("unix://") ? value.slice("unix://".length) : value;

export const preflightProviderAcceptanceCell = ({
  cell,
  env,
  platform,
  isSocket,
}: ProviderAcceptancePreflightInput): ProviderAcceptancePrerequisites => {
  const requiredPlatform = requiredPlatformFor(cell.runsOn);
  if (requiredPlatform !== undefined && platform !== requiredPlatform) {
    return { available: false, reason: `${cell.id} requires ${requiredPlatform}, received ${platform}.` };
  }
  if (cell.requiredEnv === undefined) return { available: true };
  const value = env[cell.requiredEnv];
  if (value === undefined || value.length === 0)
    return { available: false, reason: `${cell.requiredEnv} was not set.` };
  const socketPath = cell.provider === "docker" ? dockerSocketPath(value) : value;
  return isSocket(socketPath)
    ? { available: true }
    : { available: false, reason: `${cell.requiredEnv} is not a socket: ${value}` };
};

export const runProviderAcceptanceCell = async ({
  cell,
  runCommand,
  prerequisites = { available: true },
}: RunProviderAcceptanceCellInput): Promise<ProviderAcceptanceReport> => {
  if (cell.advisorySkipReason !== undefined) {
    return skippedReport(cell, { kind: "advisory", reason: cell.advisorySkipReason, blocksRelease: false });
  }
  const skipped = missingPrerequisiteSkip(cell, prerequisites);
  if (skipped !== undefined) return skipped;

  const checks: ProviderAcceptanceCheckReport[] = [];
  for (const check of cell.checks) {
    checks.push(checkReport(cell, check, await runCommand(check.command)));
  }
  return {
    schemaVersion: 1,
    cellId: cell.id,
    provider: cell.provider,
    engine: cell.engine,
    runsOn: cell.runsOn,
    releaseBlocking: cell.releaseBlocking,
    outcome: checks.every((check) => check.outcome === "passed") ? "passed" : "failed",
    checks,
  };
};

export const evaluateProviderAcceptanceReport = (
  report: ProviderAcceptanceReport,
): ProviderAcceptanceEvaluation => {
  if (!report.releaseBlocking) return { exitCode: 0, reason: "advisory cell" };
  switch (report.outcome) {
    case "passed":
      return { exitCode: 0, reason: "release-blocking cell passed" };
    case "failed":
      return { exitCode: 1, reason: "release-blocking cell failed" };
    case "skipped":
      return { exitCode: 1, reason: "release-blocking cell skipped" };
    default:
      return assertNever(report.outcome);
  }
};

export const writeProviderAcceptanceReport = async ({
  report,
  path,
}: WriteProviderAcceptanceReportInput): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
};

export const runBunCommand = async (command: readonly string[]): Promise<CommandResult> => {
  const proc = Bun.spawn({ cmd: Array.from(command), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const assertNever = (value: never): never => value;
