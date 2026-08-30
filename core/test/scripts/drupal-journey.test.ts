import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type DrupalJourneyClassification,
  type DrupalJourneyStep,
  type DrupalJourneyStepResult,
  buildDrupalJourneyPlan,
  classifyDrupalJourney,
} from "../../../scripts/drupal-journey.ts";

const BINARY = "/tmp/lando-binary";
const MODULE_PATH = resolve(import.meta.dirname, "../../../scripts/drupal-journey.ts");

const expectedPlan = (name: string): readonly DrupalJourneyStep[] => [
  {
    id: "init",
    argv: [BINARY, "init", "--recipe", "drupal", "--name", name, "--yes"],
  },
  { id: "start", argv: [BINARY, "start"] },
  { id: "info", argv: [BINARY, "info"] },
  { id: "scaffold", argv: [BINARY, "drupal-scaffold"] },
  {
    id: "composer-json",
    argv: [BINARY, "exec", "appserver", "--", "test", "-f", "/app/composer.json"],
  },
  {
    id: "drush-bin",
    argv: [BINARY, "exec", "appserver", "--", "test", "-x", "/app/vendor/bin/drush"],
  },
  { id: "drush-version", argv: [BINARY, "drush", "--version"] },
  { id: "destroy", argv: [BINARY, "destroy", "-y"] },
];

const passingSteps = (): readonly DrupalJourneyStepResult[] => [
  { id: "init", exitCode: 0, stdout: "", stderr: "" },
  { id: "start", exitCode: 0, stdout: "", stderr: "" },
  { id: "info", exitCode: 0, stdout: "https://example.lndo.site", stderr: "" },
  { id: "scaffold", exitCode: 0, stdout: "", stderr: "" },
  { id: "composer-json", exitCode: 0, stdout: "", stderr: "" },
  { id: "drush-bin", exitCode: 0, stdout: "", stderr: "" },
  { id: "drush-version", exitCode: 0, stdout: "", stderr: "" },
  { id: "destroy", exitCode: 0, stdout: "", stderr: "" },
];

describe("drupal journey plan", () => {
  test("buildDrupalJourneyPlan uses default name drupal-journey and exact 8-step order", () => {
    // Given: a binary and no name override.
    // When: buildDrupalJourneyPlan is called.
    // Then: the plan is eight steps in locked order with default name drupal-journey.
    const plan = buildDrupalJourneyPlan({ binary: BINARY });
    expect(plan).toEqual(expectedPlan("drupal-journey"));
  });

  test("buildDrupalJourneyPlan honors custom name in init argv only", () => {
    // Given: a binary and a custom app name distinct from the default.
    // When: buildDrupalJourneyPlan is called with that name.
    // Then: only the init step argv includes the custom name.
    const name = "site-alpha";
    const plan = buildDrupalJourneyPlan({ binary: BINARY, name });
    expect(plan).toEqual(expectedPlan(name));
    expect(plan.slice(1).some((step) => step.argv.includes(name))).toBe(false);
  });
});

describe("drupal journey classification", () => {
  test("classify passes when all steps exit 0 and info stdout contains https://example.lndo.site", () => {
    // Given: all eight steps in order with exit 0 and info stdout containing an https URL.
    // When: classifyDrupalJourney is called.
    // Then: the classification is passed with exitCode 0.
    const classification: DrupalJourneyClassification = classifyDrupalJourney(passingSteps());
    expect(classification).toEqual({ outcome: "passed", exitCode: 0 });
  });

  test("classify fails when any step has non-zero exit even if others pass", () => {
    // Given: a passing journey except start exits 1.
    // When: classifyDrupalJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().map((step) => (step.id === "start" ? { ...step, exitCode: 1 } : step));
    expect(classifyDrupalJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("classify fails when info stdout has no URL", () => {
    // Given: a passing journey except info stdout has no http(s) URL.
    // When: classifyDrupalJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().map((step) =>
      step.id === "info" ? { ...step, stdout: "appserver is running" } : step,
    );
    expect(classifyDrupalJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("classify fails when composer-json step missing", () => {
    // Given: a passing journey with the composer-json step removed.
    // When: classifyDrupalJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().filter((step) => step.id !== "composer-json");
    expect(classifyDrupalJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("classify fails when destroy exit non-zero", () => {
    // Given: a passing journey except destroy exits 2.
    // When: classifyDrupalJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().map((step) => (step.id === "destroy" ? { ...step, exitCode: 2 } : step));
    expect(classifyDrupalJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });
});

describe("drupal journey module source", () => {
  test("does not include advisory-skip or continue-on-error", async () => {
    // Given: the drupal-journey module source on disk.
    // When: the file text is read.
    // Then: it contains neither advisory-skip nor continue-on-error.
    const source = await readFile(MODULE_PATH, "utf8");
    expect(source).not.toContain("advisory-skip");
    expect(source).not.toContain("continue-on-error");
  });
});
