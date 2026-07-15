#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const WINDOWS_PREREQUISITE_MESSAGE =
  "Windows virtualization prerequisites are not available. Hyper-V, WSL2, and Virtual Machine Platform are required.";
const EVIDENCE_LIMIT = 12_000;

export interface WindowsManagedSetupCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type WindowsManagedSetupClassification =
  | { readonly outcome: "passed"; readonly exitCode: 0 }
  | { readonly outcome: "skipped"; readonly exitCode: 0; readonly reason: string }
  | { readonly outcome: "failed"; readonly exitCode: 1; readonly reason: string };

const setupFailureMessage = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("apiVersion" in value) || value.apiVersion !== "v4") return undefined;
  if (!("command" in value) || value.command !== "meta:setup") return undefined;
  if (!("ok" in value) || value.ok !== false) return undefined;
  if (!("error" in value) || typeof value.error !== "object" || value.error === null) return undefined;
  if (!("_tag" in value.error) || value.error._tag !== "ProviderUnavailableError") return undefined;
  if (!("message" in value.error) || typeof value.error.message !== "string") return undefined;
  return value.error.message;
};

const structuredSetupFailureMessages = (result: WindowsManagedSetupCommandResult): readonly string[] =>
  `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).flatMap((line) => {
    if (!line.trimStart().startsWith("{")) return [];
    try {
      const message = setupFailureMessage(JSON.parse(line));
      return message === undefined ? [] : [message];
    } catch (cause) {
      if (cause instanceof SyntaxError) return [];
      throw cause;
    }
  });

export const classifyWindowsManagedSetupResult = (
  result: WindowsManagedSetupCommandResult,
): WindowsManagedSetupClassification => {
  if (result.exitCode === 0) return { outcome: "passed", exitCode: 0 };
  const failures = structuredSetupFailureMessages(result);
  if (failures.length === 1 && failures[0] === WINDOWS_PREREQUISITE_MESSAGE) {
    return {
      outcome: "skipped",
      exitCode: 0,
      reason: "Windows virtualization prerequisites are not available on this runner.",
    };
  }
  return {
    outcome: "failed",
    exitCode: 1,
    reason: `Compiled Windows managed setup exited with code ${result.exitCode}.`,
  };
};

interface CliOptions {
  readonly binary: string;
  readonly report: string;
}

class WindowsManagedSetupArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsManagedSetupArgumentError";
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
    throw new WindowsManagedSetupArgumentError(
      "Usage: windows-managed-setup-acceptance.ts --binary <path> --report <path>",
    );
  }
  return { binary: resolve(binary), report: resolve(report) };
};

const bounded = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseCliOptions(args);
  const command = [options.binary, "setup", "--yes", "--no-interactive", "--provider=lando", "--format=json"];
  const proc = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe", env: process.env });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const result = { exitCode, stdout, stderr } satisfies WindowsManagedSetupCommandResult;
  const classification = classifyWindowsManagedSetupResult(result);
  const report = {
    schemaVersion: 1,
    id: "windows-managed-setup-api",
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
