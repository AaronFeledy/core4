import { describe, expect, test } from "bun:test";

import { buildSetupReadinessDoctorCheck } from "../../src/cli/commands/doctor-setup-readiness";
import type { SetupReadinessSummary } from "../../src/cli/commands/setup-readiness";

describe("doctor setup readiness", () => {
  test("treats optional skipped file-sync as ready without setup remediation", () => {
    const summary = {
      status: "ready",
      providerId: "lando",
      updatedAt: "2026-09-22T00:00:00.000Z",
      steps: [
        {
          id: "provider",
          status: "satisfied",
          evidence: "Provider setup completed.",
        },
        {
          id: "file-sync",
          status: "skipped",
          evidence: "No live file-sync engine is available; ordinary mounts remain available.",
          remediation: "Continue with ordinary mounts; accelerated file sync is unavailable in this build.",
        },
      ],
    } satisfies SetupReadinessSummary;

    const check = buildSetupReadinessDoctorCheck(summary, {
      id: "lando",
      displayName: "Lando",
      version: "0.0.0-test",
    });

    expect(check.status).toBe("pass");
    expect(check.runtimeStatus).toBe("ready");
    expect(check.context.stepFileSync).toBe("skipped");
    expect(check.context.lastFailedStep).toBeUndefined();
    expect(check.solutions).toEqual([]);
  });
});
