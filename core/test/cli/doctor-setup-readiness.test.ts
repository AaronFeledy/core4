import { describe, expect, test } from "bun:test";

import { buildSetupReadinessDoctorCheck } from "../../src/cli/commands/doctor-setup-readiness";
import type { SetupReadinessSummary } from "../../src/cli/commands/setup-readiness";

describe("doctor setup readiness", () => {
  test.each([
    { status: "in-progress", providerId: "lando", command: "lando setup" },
    { status: "in-progress", providerId: "docker", command: "lando setup --provider=docker" },
    { status: "failed", providerId: "podman", command: "lando setup --provider=podman" },
  ] as const)("warns and offers `$command` when a $status record has no failed step", (row) => {
    const check = buildSetupReadinessDoctorCheck({
      status: row.status,
      providerId: row.providerId,
      updatedAt: "2026-09-22T00:00:00.000Z",
      steps: [{ id: "provider", status: "satisfied", evidence: "Provider setup completed." }],
    });

    expect(check.status).toBe("warn");
    expect(check.context.setupStatus).toBe(row.status);
    expect(check.solutions).toEqual([
      { kind: "manual", description: expect.stringContaining(`\`${row.command}\``), command: row.command },
    ]);
  });
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

    const check = buildSetupReadinessDoctorCheck(summary);

    expect(check.status).toBe("pass");
    expect(check.context.setupStatus).toBe("ready");
    expect(check.context.stepFileSync).toBe("skipped");
    expect(check.context.lastFailedStep).toBeUndefined();
    expect(check.solutions).toEqual([]);
  });
});
