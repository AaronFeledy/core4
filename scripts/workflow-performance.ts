#!/usr/bin/env bun
import { resolve } from "node:path";

import {
  evaluateWorkflowPerformanceReport,
  writeWorkflowPerformanceReport,
} from "./workflow-performance-report.ts";
import { runWorkflowPerformance } from "./workflow-performance-runner.ts";

type CliOptions = {
  readonly binary: string;
  readonly report: string;
  readonly rootDir: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly commit: string;
  readonly platform: string;
  readonly architecture: string;
  readonly runner: string;
  readonly binaryVersion: string;
  readonly runtimeVersion: string;
  readonly providerVersion: string;
  readonly fixtureSeed: string;
  readonly startSampleCount: number;
  readonly heavySampleCount: number;
  readonly failingFixtureLane?: "mysql-import" | "postgres-import";
};

class WorkflowPerformanceArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPerformanceArgumentError";
  }
}

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const required = (args: readonly string[], flag: string): string => {
  const value = valueAfter(args, flag);
  if (value === undefined || value.length === 0) {
    throw new WorkflowPerformanceArgumentError(`Missing required ${flag}.`);
  }
  return value;
};

const positiveInteger = (
  args: readonly string[],
  flag: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const raw = valueAfter(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new WorkflowPerformanceArgumentError(
      `${flag} must be an integer from 1 through ${String(maximum)}.`,
    );
  }
  return value;
};

const parseFailingFixtureLane = (
  value: string | undefined,
): "mysql-import" | "postgres-import" | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  if (value === "mysql-import" || value === "postgres-import") return value;
  throw new WorkflowPerformanceArgumentError(
    "--failing-fixture-lane must be mysql-import or postgres-import.",
  );
};

const parseOptions = (args: readonly string[]): CliOptions => {
  const failingFixtureLane = parseFailingFixtureLane(valueAfter(args, "--failing-fixture-lane"));
  return {
    binary: resolve(required(args, "--binary")),
    report: resolve(required(args, "--report")),
    rootDir: resolve(required(args, "--root-dir")),
    runId: required(args, "--run-id"),
    runAttempt: positiveInteger(args, "--run-attempt", 1),
    commit: required(args, "--commit"),
    platform: required(args, "--platform"),
    architecture: required(args, "--architecture"),
    runner: required(args, "--runner"),
    binaryVersion: required(args, "--binary-version"),
    runtimeVersion: required(args, "--runtime-version"),
    providerVersion: required(args, "--provider-version"),
    fixtureSeed: required(args, "--fixture-seed"),
    startSampleCount: positiveInteger(args, "--start-samples", 5, 10),
    heavySampleCount: positiveInteger(args, "--heavy-samples", 3, 10),
    ...(failingFixtureLane === undefined ? {} : { failingFixtureLane }),
  };
};

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseOptions(args);
  const report = await runWorkflowPerformance(options);
  await writeWorkflowPerformanceReport(report, options.report);
  const evaluation = evaluateWorkflowPerformanceReport(report);
  process.stdout.write(`${JSON.stringify({ report: options.report, ...evaluation })}\n`);
  process.exitCode = evaluation.exitCode;
};

if (import.meta.main) await main(process.argv.slice(2));
