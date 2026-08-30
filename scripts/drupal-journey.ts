#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EVIDENCE_LIMIT = 12_000;
const DEFAULT_NAME = "drupal-journey";

export const DRUPAL_JOURNEY_STEP_IDS = [
  "init",
  "start",
  "info",
  "scaffold",
  "composer-json",
  "drush-bin",
  "drush-version",
  "destroy",
] as const;

export type DrupalJourneyStepId = (typeof DRUPAL_JOURNEY_STEP_IDS)[number];

export type DrupalJourneyStep = {
  readonly id: DrupalJourneyStepId;
  readonly argv: readonly string[];
};

export type DrupalJourneyStepResult = {
  readonly id: DrupalJourneyStepId;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type DrupalJourneyClassification =
  | { readonly outcome: "passed"; readonly exitCode: 0 }
  | { readonly outcome: "failed"; readonly exitCode: 1; readonly reason: string };

export type DrupalJourneyPlanOptions = {
  readonly binary: string;
  readonly name?: string;
};

const failed = (reason: string): DrupalJourneyClassification => ({
  outcome: "failed",
  exitCode: 1,
  reason,
});

export const buildDrupalJourneyPlan = (options: DrupalJourneyPlanOptions): readonly DrupalJourneyStep[] => {
  const name = options.name ?? DEFAULT_NAME;
  const { binary } = options;
  return [
    { id: "init", argv: [binary, "init", "--recipe", "drupal", "--name", name, "--yes"] },
    { id: "start", argv: [binary, "start"] },
    { id: "info", argv: [binary, "info"] },
    { id: "scaffold", argv: [binary, "drupal-scaffold"] },
    {
      id: "composer-json",
      argv: [binary, "exec", "appserver", "--", "test", "-f", "/app/composer.json"],
    },
    {
      id: "drush-bin",
      argv: [binary, "exec", "appserver", "--", "test", "-x", "/app/vendor/bin/drush"],
    },
    { id: "drush-version", argv: [binary, "drush", "--version"] },
    { id: "destroy", argv: [binary, "destroy", "-y"] },
  ];
};

const stdoutHasUrl = (stdout: string): boolean => stdout.includes("http://") || stdout.includes("https://");

export const classifyDrupalJourney = (
  steps: readonly DrupalJourneyStepResult[],
): DrupalJourneyClassification => {
  if (steps.length !== DRUPAL_JOURNEY_STEP_IDS.length) {
    return failed(`Expected ${DRUPAL_JOURNEY_STEP_IDS.length} steps, got ${steps.length}.`);
  }

  for (const [index, expectedId] of DRUPAL_JOURNEY_STEP_IDS.entries()) {
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

class DrupalJourneyArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrupalJourneyArgumentError";
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
    throw new DrupalJourneyArgumentError(
      "Usage: drupal-journey.ts --binary <path> --report <path> --app-dir <path> [--name <name>]",
    );
  }
  const resolved = { binary: resolve(binary), report: resolve(report), appDir: resolve(appDir) };
  return name === undefined ? resolved : { ...resolved, name };
};

const bounded = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

const evidenceFor = (
  steps: readonly DrupalJourneyStepResult[],
  id: DrupalJourneyStepId,
): { readonly stdout: string; readonly stderr: string } => {
  const step = steps.find((result) => result.id === id);
  return { stdout: bounded(step?.stdout ?? ""), stderr: bounded(step?.stderr ?? "") };
};

const runStep = async (step: DrupalJourneyStep, cwd: string): Promise<DrupalJourneyStepResult> => {
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
};

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseCliOptions(args);
  await mkdir(options.appDir, { recursive: true });
  const plan =
    options.name === undefined
      ? buildDrupalJourneyPlan({ binary: options.binary })
      : buildDrupalJourneyPlan({ binary: options.binary, name: options.name });

  const appName = options.name ?? DEFAULT_NAME;
  const appRoot = resolve(options.appDir, appName);
  const steps: DrupalJourneyStepResult[] = [];
  for (const step of plan) {
    const cwd = step.id === "init" ? options.appDir : appRoot;
    steps.push(await runStep(step, cwd));
  }

  const classification = classifyDrupalJourney(steps);
  const report = {
    schemaVersion: 1,
    id: "drupal-journey",
    steps,
    classification,
    evidence: {
      info: evidenceFor(steps, "info"),
      drush: evidenceFor(steps, "drush-version"),
    },
  } as const;

  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ report: options.report, ...classification })}\n`);
  process.exitCode = classification.exitCode;
};

if (import.meta.main) await main(process.argv.slice(2));
