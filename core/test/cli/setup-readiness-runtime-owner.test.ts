import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionOwner } from "@lando/redaction/service";
import { Effect } from "effect";
import { makeSetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import {
  readSetupReadiness,
  setupReadinessPath,
  writeSetupReadiness,
} from "../../src/cli/commands/setup-readiness.ts";

test("readiness persists only masked diagnostics after late runtime registration", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-readiness-owner-"));
  const owner = makeRedactionOwner();
  const recorder = makeSetupReadinessRecorder(root, "podman", owner.service);
  const canary = "opaque-readiness-runtime-owned";
  const operationalValue = "opaque-readiness-operational-state";
  const runtimeService = {
    running: true,
    socketPath: `/socket/${operationalValue}`,
    runtimeVersion: operationalValue,
  };
  recorder.setRuntimeService(runtimeService);
  Effect.runSync(owner.service.registerValues([canary, operationalValue]));
  try {
    // When
    await Effect.runPromise(recorder.recordFailure("provider", new Error(`failed ${canary}`)));
    // Then
    const persisted = await readFile(setupReadinessPath(root), "utf8");
    expect(persisted).not.toContain(canary);
    expect(JSON.parse(persisted)).toMatchObject({
      status: "failed",
      runtimeService,
      steps: [{ id: "provider", status: "failed", evidence: "provider setup failed: failed [redacted]" }],
    });
    expect(recorder.firstFailedStep()?.remediation).toContain("Last failure: failed [redacted]");
  } finally {
    owner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness read applies late runtime registrations to previously persisted diagnostics", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-readiness-read-owner-"));
  const owner = makeRedactionOwner();
  const canary = "opaque-readiness-history-value";
  try {
    await Effect.runPromise(
      writeSetupReadiness(
        root,
        "podman",
        [{ id: "provider", status: "failed", evidence: `failed ${canary}`, remediation: `retry ${canary}` }],
        { running: true, socketPath: `/socket/${canary}`, runtimeVersion: canary },
      ),
    );
    Effect.runSync(owner.service.registerValues([canary]));
    // When
    const summary = await Effect.runPromise(
      readSetupReadiness(root).pipe(Effect.provideService(RedactionService, owner.service)),
    );
    // Then
    expect(summary?.steps).toEqual([
      { id: "provider", status: "failed", evidence: "failed [redacted]", remediation: "retry [redacted]" },
    ]);
    expect(summary?.runtimeService).toEqual({
      running: true,
      socketPath: "/socket/[redacted]",
      runtimeVersion: "[redacted]",
    });
  } finally {
    owner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
