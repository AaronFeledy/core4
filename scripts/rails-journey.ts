#!/usr/bin/env bun
import { resolve } from "node:path";

import {
  type JourneyStep,
  type JourneyStepResult,
  evidenceFor,
  runJourneySteps,
  valueAfter,
  writeAcceptanceReport,
} from "./_acceptance-harness.ts";

const DEFAULT_NAME = "rails-journey";

export const RAILS_JOURNEY_STEP_IDS = ["init", "start", "info", "rails", "bundle", "destroy"] as const;

export type RailsJourneyStepId = (typeof RAILS_JOURNEY_STEP_IDS)[number];

export type RailsJourneyStep = JourneyStep<RailsJourneyStepId>;

export type RailsJourneyStepResult = JourneyStepResult<RailsJourneyStepId>;

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

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseCliOptions(args);
  const plan =
    options.name === undefined
      ? buildRailsJourneyPlan({ binary: options.binary })
      : buildRailsJourneyPlan({ binary: options.binary, name: options.name });

  const steps = await runJourneySteps(plan, options.appDir, options.name ?? DEFAULT_NAME);

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

  await writeAcceptanceReport(options.report, report, classification);
};

if (import.meta.main) await main(process.argv.slice(2));
