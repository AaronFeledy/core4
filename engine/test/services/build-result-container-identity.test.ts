import { expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { DateTime, Schema } from "effect";
import {
  AppBuildResult,
  BuildResultEntry,
  findCompleteBuildResult,
} from "../../src/services/build-results.ts";

const entry = {
  buildKey: "install-key",
  service: ServiceName.make("web"),
  phase: "app",
  step: "web:app:install",
  outcome: "complete",
  exitCode: 0,
  durationMs: 1,
  transcriptPath: AbsolutePath.make("/tmp/install.log"),
  completedAt: DateTime.makeUnsafe("2026-07-17T00:00:00Z"),
} as const;

test.each([
  { recordedId: "web-1", observedId: "web-1", hit: true },
  { recordedId: "web-1", observedId: "web-2", hit: false },
  { recordedId: "web-1", observedId: undefined, hit: false },
  { recordedId: "web-1", observedId: "", hit: false },
  { recordedId: undefined, observedId: "web-1", hit: false },
  { recordedId: "", observedId: "web-1", hit: false },
])("app reuse binds recorded $recordedId to observed $observedId", ({ recordedId, observedId, hit }) => {
  const recorded = { ...entry, ...(recordedId === undefined ? {} : { containerId: recordedId }) };
  const decoded = Schema.decodeUnknownSync(AppBuildResult)({
    ...recorded,
    completedAt: DateTime.formatIso(entry.completedAt),
  });

  const result = findCompleteBuildResult([decoded], {
    buildKey: entry.buildKey,
    service: entry.service,
    phase: "app",
    step: entry.step,
    containerId: observedId,
  });

  expect(result).toEqual(hit ? decoded : undefined);
});

test.each(["complete", "fail"] as const)(
  "a newer %s attempt on another container never falls back to an older matching success",
  (outcome) => {
    const older = { ...entry, containerId: "web-1" };
    const newer = { ...entry, containerId: "web-2", outcome, exitCode: outcome === "fail" ? 7 : 0 };

    const result = findCompleteBuildResult([older, newer], {
      buildKey: entry.buildKey,
      service: entry.service,
      phase: "app",
      step: entry.step,
      containerId: "web-1",
    });

    expect(result).toBeUndefined();
  },
);

test("unknown app identity misses without discarding artifact evidence", () => {
  const { step: _, exitCode: _exit, ...artifactFields } = entry;
  const legacyArtifact = { ...artifactFields, phase: "artifact" as const, artifactRef: "web:built" };
  const entries = Schema.decodeUnknownSync(Schema.Array(BuildResultEntry))([
    { ...entry, completedAt: DateTime.formatIso(entry.completedAt) },
    { ...legacyArtifact, completedAt: DateTime.formatIso(entry.completedAt) },
  ]);

  const app = findCompleteBuildResult(entries, {
    buildKey: entry.buildKey,
    service: entry.service,
    phase: "app",
    step: entry.step,
    containerId: "web-1",
  });
  const artifact = findCompleteBuildResult(entries, {
    buildKey: entry.buildKey,
    service: entry.service,
    phase: "artifact",
  });

  expect(app).toBeUndefined();
  expect(artifact?.artifactRef).toBe("web:built");
});
