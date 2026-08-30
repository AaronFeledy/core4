import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type RailsJourneyClassification,
  type RailsJourneyStep,
  type RailsJourneyStepResult,
  buildRailsJourneyPlan,
  classifyRailsJourney,
} from "../../../scripts/rails-journey.ts";

const BINARY = "/tmp/lando-binary";
const MODULE_PATH = resolve(import.meta.dirname, "../../../scripts/rails-journey.ts");

const expectedPlan = (name: string): readonly RailsJourneyStep[] => [
  {
    id: "init",
    argv: [BINARY, "init", "--recipe", "rails", "--name", name, "--yes"],
  },
  { id: "start", argv: [BINARY, "start"] },
  { id: "info", argv: [BINARY, "info"] },
  { id: "rails", argv: [BINARY, "rails"] },
  { id: "bundle", argv: [BINARY, "bundle"] },
  { id: "destroy", argv: [BINARY, "destroy", "-y"] },
];

const passingSteps = (): readonly RailsJourneyStepResult[] => [
  { id: "init", exitCode: 0, stdout: "", stderr: "" },
  { id: "start", exitCode: 0, stdout: "", stderr: "" },
  { id: "info", exitCode: 0, stdout: "https://example.lndo.site", stderr: "" },
  { id: "rails", exitCode: 0, stdout: "", stderr: "" },
  { id: "bundle", exitCode: 0, stdout: "", stderr: "" },
  { id: "destroy", exitCode: 0, stdout: "", stderr: "" },
];

describe("rails journey plan", () => {
  test("buildRailsJourneyPlan uses default name rails-journey and exact 6-step order", () => {
    // Given: a binary and no name override.
    // When: buildRailsJourneyPlan is called.
    // Then: the plan is six steps in locked order with default name rails-journey.
    const plan = buildRailsJourneyPlan({ binary: BINARY });
    expect(plan).toEqual(expectedPlan("rails-journey"));
  });

  test("buildRailsJourneyPlan honors custom name in init argv only", () => {
    // Given: a binary and a custom app name distinct from the default.
    // When: buildRailsJourneyPlan is called with that name.
    // Then: only the init step argv includes the custom name.
    const name = "site-alpha";
    const plan = buildRailsJourneyPlan({ binary: BINARY, name });
    expect(plan).toEqual(expectedPlan(name));
    expect(plan.slice(1).some((step) => step.argv.includes(name))).toBe(false);
  });
});

describe("rails journey classification", () => {
  test("classify passes when all steps exit 0 and info stdout contains https://example.lndo.site", () => {
    // Given: all six steps in order with exit 0 and info stdout containing an https URL.
    // When: classifyRailsJourney is called.
    // Then: the classification is passed with exitCode 0.
    const classification: RailsJourneyClassification = classifyRailsJourney(passingSteps());
    expect(classification).toEqual({ outcome: "passed", exitCode: 0 });
  });

  test("classify fails when any step has non-zero exit even if others pass", () => {
    // Given: a passing journey except start exits 1.
    // When: classifyRailsJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().map((step) => (step.id === "start" ? { ...step, exitCode: 1 } : step));
    expect(classifyRailsJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("classify fails when info stdout has no URL", () => {
    // Given: a passing journey except info stdout has no http(s) URL.
    // When: classifyRailsJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().map((step) =>
      step.id === "info" ? { ...step, stdout: "appserver is running" } : step,
    );
    expect(classifyRailsJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("classify fails when rails step is missing", () => {
    // Given: a passing journey with the rails step removed.
    // When: classifyRailsJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().filter((step) => step.id !== "rails");
    expect(classifyRailsJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("classify fails when destroy exit non-zero", () => {
    // Given: a passing journey except destroy exits 2.
    // When: classifyRailsJourney is called.
    // Then: the classification is failed with exitCode 1.
    const steps = passingSteps().map((step) => (step.id === "destroy" ? { ...step, exitCode: 2 } : step));
    expect(classifyRailsJourney(steps)).toMatchObject({ outcome: "failed", exitCode: 1 });
  });
});

describe("rails journey module source", () => {
  test("does not include advisory-skip or continue-on-error", async () => {
    // Given: the rails-journey module source on disk.
    // When: the file text is read.
    // Then: it contains neither advisory-skip nor continue-on-error.
    const source = await readFile(MODULE_PATH, "utf8");
    expect(source).not.toContain("advisory-skip");
    expect(source).not.toContain("continue-on-error");
  });
});

describe("rails journey runner", () => {
  test("stops after failed init and still writes the JSON report", async () => {
    // Given: a stub binary that fails init and records every invoked command.
    // When: rails-journey.ts is run against that stub.
    // Then: only init is invoked, the report is written, and classification is failed.
    const dir = await mkdtemp(join(tmpdir(), "rails-journey-"));
    const trace = join(dir, "trace");
    const stub = join(dir, "lando-stub");
    const report = join(dir, "report.json");
    const appDir = join(dir, "app");
    await writeFile(
      stub,
      `#!/usr/bin/env bash
echo "$1" >> "${trace}"
if [ "$1" = "init" ]; then exit 1; fi
exit 0
`,
    );
    await chmod(stub, 0o755);

    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, MODULE_PATH, "--binary", stub, "--report", report, "--app-dir", appDir],
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
      expect(await readFile(trace, "utf8")).toBe("init\n");
      const written = JSON.parse(await readFile(report, "utf8")) as {
        readonly classification: RailsJourneyClassification;
        readonly steps: readonly RailsJourneyStepResult[];
      };
      expect(written.classification.outcome).toBe("failed");
      expect(written.steps.map((step) => step.id)).toEqual(["init"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
