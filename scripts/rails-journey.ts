#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EVIDENCE_LIMIT = 12_000;
const DEFAULT_NAME = "rails-journey";

export const RAILS_JOURNEY_STEP_IDS = ["init", "start", "info", "rails", "bundle", "destroy"] as const;

export type RailsJourneyStepId = (typeof RAILS_JOURNEY_STEP_IDS)[number];

export type RailsJourneyStep = {
  readonly id: RailsJourneyStepId;
  readonly argv: readonly string[];
};

export type RailsJourneyStepResult = {
  readonly id: RailsJourneyStepId;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RailsJourneyClassification =
  | { readonly outcome: "passed"; readonly exitCode: 0 }
  | { readonly outcome: "failed"; readonly exitCode: 1; readonly reason: string };

export type RailsJourneyPlanOptions = {
  readonly binary: string;
  readonly name?: string;
};

const failed = (reason: string): RailsJourneyClassification => ({
  outcome: "failed",
  exitCode: 1,
  reason,
});

export const buildRailsJourneyPlan = (options: RailsJourneyPlanOptions): readonly RailsJourneyStep[] => {
  const name = options.name ?? DEFAULT_NAME;
  const { binary } = options;
  return [
    { id: "init", argv: [binary, "init", "--recipe", "rails", "--name", name, "--yes"] },
    { id: "start", argv: [binary, "start"] },
    { id: "info", argv: [binary, "info"] },
    { id: "rails", argv: [binary, "rails"] },
    { id: "bundle", argv: [binary, "bundle"] },
    { id: "destroy", argv: [binary, "destroy", "-y"] },
  ];
};

const stdoutHasUrl = (stdout: string): boolean => stdout.includes("http://") || stdout.includes("https://");

export const classifyRailsJourney = (
  steps: readonly RailsJourneyStepResult[],
): RailsJourneyClassification => {
  if (steps.length !== RAILS_JOURNEY_STEP_IDS.length) {
    return failed(`Expected ${RAILS_JOURNEY_STEP_IDS.length} steps, got ${steps.length}.`);
  }

  for (const [index, expectedId] of RAILS_JOURNEY_STEP_IDS.entries()) {
    const step = steps[index];
    if (step === undefined || step.id !== expectedId) {
      return failed(`Step ${index} was not ${expectedId}.`);
    }
    if (step.exitCode !== 0) {
      return failed(`Step ${expectedId} exited with code ${step.exitCode}.`);
    }
  }

  const info = steps.find((step) => step.id === "info");
  if (info === undefined || !stdoutHasUrl(info.stdout)) {
    return failed("Info stdout did not include an http(s) URL.");
  }

  return { outcome: "passed", exitCode: 0 };
};

type CliOptions = {
  readonly binary: string;
  readonly report: string;
  readonly appDir: string;
  readonly name?: string;
};

class RailsJourneyArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailsJourneyArgumentError";
  }
}

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const parseCliOptions = (args: readonly string[]): CliOptions => {
  const binary = valueAfter(args, "--binary");
  const report = valueAfter(args, "--report");
  const appDir = valueAfter(args, "--app-dir");
  const name = valueAfter(args, "--name");
  if (binary === undefined || report === undefined || appDir === undefined) {
    throw new RailsJourneyArgumentError(
      "Usage: rails-journey.ts --binary <path> --report <path> --app-dir <path> [--name <name>]",
    );
  }
  const resolved = { binary: resolve(binary), report: resolve(report), appDir: resolve(appDir) };
  return name === undefined ? resolved : { ...resolved, name };
};

const bounded = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

const evidenceFor = (
  steps: readonly RailsJourneyStepResult[],
  id: RailsJourneyStepId,
): { readonly stdout: string; readonly stderr: string } => {
  const step = steps.find((result) => result.id === id);
  return { stdout: bounded(step?.stdout ?? ""), stderr: bounded(step?.stderr ?? "") };
};

const spawnFailure = (step: RailsJourneyStep, cause: unknown): RailsJourneyStepResult => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { id: step.id, exitCode: 1, stdout: "", stderr: bounded(message) };
};

const runStep = async (step: RailsJourneyStep, cwd: string): Promise<RailsJourneyStepResult> => {
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
    return { id: step.id, exitCode, stdout, stderr };
  } catch (cause) {
    return spawnFailure(step, cause);
  }
};

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseCliOptions(args);
  await mkdir(options.appDir, { recursive: true });
  const plan =
    options.name === undefined
      ? buildRailsJourneyPlan({ binary: options.binary })
      : buildRailsJourneyPlan({ binary: options.binary, name: options.name });

  const appName = options.name ?? DEFAULT_NAME;
  const appRoot = resolve(options.appDir, appName);
  const steps: RailsJourneyStepResult[] = [];
  for (const step of plan) {
    const cwd = step.id === "init" ? options.appDir : appRoot;
    const result = await runStep(step, cwd);
    steps.push(result);
    if (result.exitCode !== 0) {
      break;
    }
  }

  const classification = classifyRailsJourney(steps);
  const report = {
    schemaVersion: 1,
    id: "rails-journey",
    steps,
    classification,
    evidence: {
      info: evidenceFor(steps, "info"),
      rails: evidenceFor(steps, "rails"),
    },
  } as const;

  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ report: options.report, ...classification })}\n`);
  process.exitCode = classification.exitCode;
};

if (import.meta.main) await main(process.argv.slice(2));
