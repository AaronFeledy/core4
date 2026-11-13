#!/usr/bin/env bun
import { resolve } from "node:path";

import { bounded, valueAfter, writeAcceptanceReport } from "./_acceptance-harness.ts";

export interface PlatformReadinessDoctorCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PlatformReadinessDoctorClassification =
  | { readonly outcome: "passed"; readonly exitCode: 0 }
  | { readonly outcome: "failed"; readonly exitCode: 1; readonly reason: string };

const failed = (reason: string): PlatformReadinessDoctorClassification => ({
  outcome: "failed",
  exitCode: 1,
  reason,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseStdoutJson = (stdout: string): unknown | undefined => {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    if (cause instanceof SyntaxError) return undefined;
    throw cause;
  }
};

const checkFailed = (check: unknown): boolean => isRecord(check) && check.status === "fail";

const isDoctorSelf = (check: unknown): boolean => isRecord(check) && check.name === "doctor-self";

const isPassingSetupReadiness = (check: unknown): boolean =>
  isRecord(check) && check.name === "setup-readiness" && check.status === "pass";

export const classifyPlatformReadinessDoctorResult = (
  result: PlatformReadinessDoctorCommandResult,
): PlatformReadinessDoctorClassification => {
  if (result.exitCode !== 0) {
    return failed(`Doctor exited with code ${result.exitCode}.`);
  }

  const parsed = parseStdoutJson(result.stdout);
  if (!isRecord(parsed)) {
    return failed("Doctor stdout was not a JSON object.");
  }
  if (parsed.apiVersion !== "v4") {
    return failed("Doctor envelope apiVersion was not v4.");
  }
  if (parsed.command !== "meta:doctor") {
    return failed("Doctor envelope command was not meta:doctor.");
  }
  if (parsed.ok !== true) {
    return failed("Doctor envelope ok was not true.");
  }

  const report = parsed.result;
  if (!isRecord(report)) {
    return failed("Doctor envelope result was not an object.");
  }
  const checks: readonly unknown[] = Array.isArray(report.checks) ? report.checks : [];
  if (checks.some(isDoctorSelf)) {
    return failed("Doctor report included a doctor-self failure.");
  }
  if (checks.some(checkFailed)) {
    return failed("Doctor report included a failing check.");
  }
  if (!checks.some(isPassingSetupReadiness)) {
    return failed("Doctor report did not include a passing setup-readiness check.");
  }

  return { outcome: "passed", exitCode: 0 };
};

interface CliOptions {
  readonly binary: string;
  readonly report: string;
}

class PlatformReadinessDoctorArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformReadinessDoctorArgumentError";
  }
}

const parseCliOptions = (args: readonly string[]): CliOptions => {
  const binary = valueAfter(args, "--binary");
  const report = valueAfter(args, "--report");
  if (binary === undefined || report === undefined) {
    throw new PlatformReadinessDoctorArgumentError(
      "Usage: platform-readiness-doctor.ts --binary <path> --report <path>",
    );
  }
  return { binary: resolve(binary), report: resolve(report) };
};

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseCliOptions(args);
  const command = [options.binary, "doctor", "--format", "json"];
  const proc = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe", env: process.env });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const result = { exitCode, stdout, stderr } satisfies PlatformReadinessDoctorCommandResult;
  const classification = classifyPlatformReadinessDoctorResult(result);
  const report = {
    schemaVersion: 1,
    id: "platform-readiness-doctor",
    command,
    ...classification,
    evidence: { exitCode, stdout: bounded(stdout), stderr: bounded(stderr) },
  } as const;

  await writeAcceptanceReport(options.report, report, classification);
};

if (import.meta.main) await main(process.argv.slice(2));
