#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EVIDENCE_LIMIT = 12_000;
const CHECK_SECTIONS = ["provider", "subsystems", "globalApp", "mcp"] as const;

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

const sectionChecks = (section: unknown): readonly unknown[] => {
  if (!isRecord(section)) return [];
  const checks = section.checks;
  return Array.isArray(checks) ? checks : [];
};

const checkFailed = (check: unknown): boolean => isRecord(check) && check.status === "fail";

const isPassingSetupReadiness = (check: unknown): boolean => {
  if (!isRecord(check)) return false;
  if (check.name !== "setup-readiness" || check.status !== "pass") return false;
  const runtime = check.runtime;
  return isRecord(runtime) && runtime.running === true;
};

export const classifyPlatformReadinessDoctorResult = (
  result: PlatformReadinessDoctorCommandResult,
): PlatformReadinessDoctorClassification => {
  if (result.exitCode !== 0) {
    return failed(`Doctor exited with code ${result.exitCode}.`);
  }

  const parsed = parseStdoutJson(result.stdout);
  if (parsed === undefined || !isRecord(parsed)) {
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
  if (isRecord(report.self)) {
    return failed("Doctor report included a self object.");
  }

  for (const section of CHECK_SECTIONS) {
    if (sectionChecks(report[section]).some(checkFailed)) {
      return failed(`Doctor report included a failing ${section} check.`);
    }
  }

  if (!sectionChecks(report.provider).some(isPassingSetupReadiness)) {
    return failed("Doctor report did not include a passing setup-readiness check with a running runtime.");
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

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

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

const bounded = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

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

  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ report: options.report, ...classification })}\n`);
  process.exitCode = classification.exitCode;
};

if (import.meta.main) await main(process.argv.slice(2));
