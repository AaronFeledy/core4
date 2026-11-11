import { expect, test } from "bun:test";
import { HostUninstallOutcome, UninstallPlanStep, UninstallStepResult } from "@lando/sdk/schema";
import { Schema } from "effect";

const step = { id: "resource", label: "resource", target: "/resource", destructive: true, detail: "remove" };

test.each([
  { outcome: "completed", error: "failure" },
  { outcome: "skipped", error: "failure" },
  { outcome: "manual", detail: "preserved", error: "failure" },
  { outcome: "manual" },
  { outcome: "failed" },
])("host uninstall outcome rejects incomplete or contradictory result %j", (outcome) => {
  expect(Schema.decodeUnknownOption(HostUninstallOutcome)(outcome)._tag).toBe("None");
});

test.each([
  { outcome: "completed" },
  { outcome: "skipped" },
  { outcome: "manual", detail: "preserved" },
  { outcome: "failed", error: "denied" },
])("host uninstall outcome round trips %j", (outcome) => {
  const decoded = Schema.decodeUnknownSync(HostUninstallOutcome)(outcome);
  expect(Schema.encodeSync(HostUninstallOutcome)(decoded)).toEqual(outcome);
});

for (const [status, outcomes] of [
  ["owned", ["completed", "skipped", "manual", "failed"]],
  ["user-owned", ["manual", "failed"]],
  ["skipped", ["skipped"]],
  ["manual", ["completed", "manual", "failed"]],
] as const) {
  test(`uninstall plan ${status} has no execution fields`, () => {
    const input = { ...step, status };
    expect(Schema.decodeUnknownSync(UninstallPlanStep)(input)).toEqual(input);
    expect(Schema.decodeUnknownOption(UninstallPlanStep)({ ...input, outcome: "skipped" })._tag).toBe("None");
    expect(Schema.decodeUnknownOption(UninstallPlanStep)({ ...input, error: "denied" })._tag).toBe("None");
  });

  for (const outcome of ["completed", "skipped", "manual", "failed"] as const) {
    test(`uninstall classification ${status} with outcome ${outcome}`, () => {
      const input = { ...step, status, outcome, ...(outcome === "failed" ? { error: "denied" } : {}) };
      const allowed = outcomes.some((candidate) => candidate === outcome);
      const decoded = Schema.decodeUnknownOption(UninstallStepResult)(input);
      expect(decoded._tag).toBe(allowed ? "Some" : "None");
      if (decoded._tag === "Some") {
        expect(input).toEqual(Schema.encodeSync(UninstallStepResult)(decoded.value));
      }
    });
  }
}
