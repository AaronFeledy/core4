#!/usr/bin/env bun
import { statSync } from "node:fs";
import { join } from "node:path";

export {
  buildProviderAcceptancePlan,
  PROVIDER_ACCEPTANCE_CELLS,
  UnknownProviderAcceptanceCellError,
  type ProviderAcceptanceCellId,
  type ProviderAcceptanceCellPlan,
  type ProviderAcceptanceCheckPlan,
  type ProviderId,
} from "./provider-matrix-plan.ts";
export {
  evaluateProviderAcceptanceReport,
  preflightProviderAcceptanceCell,
  runBunCommand,
  runProviderAcceptanceCell,
  writeProviderAcceptanceReport,
  type CommandResult,
  type ProviderAcceptanceCheckReport,
  type ProviderAcceptanceEvaluation,
  type ProviderAcceptanceEvidence,
  type ProviderAcceptanceOutcome,
  type ProviderAcceptancePrerequisites,
  type ProviderAcceptancePreflightInput,
  type ProviderAcceptanceReport,
  type ProviderAcceptanceSkip,
} from "./provider-matrix-report.ts";

import { type ProviderAcceptanceCellId, buildProviderAcceptancePlan } from "./provider-matrix-plan.ts";
import {
  evaluateProviderAcceptanceReport,
  preflightProviderAcceptanceCell,
  runBunCommand,
  runProviderAcceptanceCell,
  writeProviderAcceptanceReport,
} from "./provider-matrix-report.ts";

interface CliOptions {
  readonly cell: ProviderAcceptanceCellId;
  readonly reportDir: string;
}

class ProviderAcceptanceCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAcceptanceCliArgumentError";
  }
}

const isCellId = (value: string): value is ProviderAcceptanceCellId => {
  switch (value) {
    case "docker-desktop-macos":
    case "docker-engine-linux":
    case "podman-desktop-macos":
    case "lando-podman6-linux":
    case "podman-podman6-linux":
    case "lima-macos":
    case "orbstack-macos":
      return true;
    default:
      return false;
  }
};

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
};

const parseCliOptions = (args: readonly string[]): CliOptions => {
  const cell = valueAfter(args, "--cell");
  if (cell === undefined || !isCellId(cell)) {
    throw new ProviderAcceptanceCliArgumentError(
      "Usage: provider-matrix-acceptance.ts --cell <cell-id> [--report-dir <dir>]",
    );
  }
  return { cell, reportDir: valueAfter(args, "--report-dir") ?? "provider-matrix-reports" };
};

const isSocketOnDisk = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch (cause) {
    if (cause instanceof Error) return false;
    throw cause;
  }
};

const main = async (): Promise<void> => {
  const options = parseCliOptions(process.argv.slice(2));
  const cell = buildProviderAcceptancePlan(options.cell);
  const report = await runProviderAcceptanceCell({
    cell,
    prerequisites: preflightProviderAcceptanceCell({
      cell,
      env: process.env,
      platform: process.platform,
      isSocket: isSocketOnDisk,
    }),
    runCommand: runBunCommand,
  });
  await writeProviderAcceptanceReport({ report, path: join(options.reportDir, `${cell.id}.json`) });
  const evaluation = evaluateProviderAcceptanceReport(report);
  console.log(JSON.stringify({ report: join(options.reportDir, `${cell.id}.json`), evaluation }));
  process.exit(evaluation.exitCode);
};

if (import.meta.main) await main();
