import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const EVIDENCE_LIMIT = 12_000;

export const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

export const bounded = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

export const writeJsonReport = async (path: string, report: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
};

export const writeAcceptanceReport = async (
  path: string,
  report: unknown,
  classification: { readonly exitCode: number },
): Promise<void> => {
  await writeJsonReport(path, report);
  process.stdout.write(`${JSON.stringify({ report: path, ...classification })}\n`);
  process.exitCode = classification.exitCode;
};

export type JourneyStep<Id extends string> = {
  readonly id: Id;
  readonly argv: readonly string[];
};

export type JourneyStepResult<Id extends string> = {
  readonly id: Id;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const evidenceFor = <Id extends string>(
  steps: readonly JourneyStepResult<Id>[],
  id: Id,
): { readonly stdout: string; readonly stderr: string } => {
  const step = steps.find((result) => result.id === id);
  return { stdout: bounded(step?.stdout ?? ""), stderr: bounded(step?.stderr ?? "") };
};

export const runJourneySteps = async <Id extends string>(
  plan: readonly JourneyStep<Id>[],
  appDir: string,
  appName: string,
): Promise<JourneyStepResult<Id>[]> => {
  await mkdir(appDir, { recursive: true });
  const appRoot = resolve(appDir, appName);
  const steps: JourneyStepResult<Id>[] = [];
  for (const step of plan) {
    const cwd = step.id === "init" ? appDir : appRoot;
    let result: JourneyStepResult<Id>;
    try {
      const proc = Bun.spawn({
        cmd: [...step.argv],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      result = { id: step.id, exitCode, stdout, stderr };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result = { id: step.id, exitCode: 1, stdout: "", stderr: bounded(message) };
    }
    steps.push(result);
    if (result.exitCode !== 0) break;
  }
  return steps;
};
