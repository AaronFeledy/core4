import { expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import {
  openArtifactBuildResults,
  recordArtifactBuildResult,
  useArtifactBuildResult,
} from "../../src/services/build-artifact-results.ts";
import { AppBuildResult, findCompleteBuildResult } from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

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

test.each(["complete", "fail"] as const)(
  "a newer %s attempt under another key hides historical success on the same container",
  (outcome) => {
    const older = { ...entry, containerId: "web-1" };
    const newer = { ...older, buildKey: "changed-key", outcome };

    expect(findCompleteBuildResult([older, newer], { ...older, containerId: "web-1" })).toBeUndefined();
  },
);

test("unknown app identity misses without discarding artifact evidence", async () => {
  const { step: _, exitCode: _exit, ...artifactFields } = entry;
  const artifactEntry = {
    ...artifactFields,
    owner: "owner",
    providerId: "test",
    phase: "artifact" as const,
    artifactRef: "web:built",
  };
  const entries = Schema.decodeUnknownSync(Schema.Array(AppBuildResult))([
    { ...entry, completedAt: DateTime.formatIso(entry.completedAt) },
  ]);

  const app = findCompleteBuildResult(entries, {
    buildKey: entry.buildKey,
    service: entry.service,
    phase: "app",
    step: entry.step,
    containerId: "web-1",
  });
  const bucket = await Effect.runPromise(openArtifactBuildResults(makeTestStateStore().service));
  await Effect.runPromise(recordArtifactBuildResult(bucket, artifactEntry));
  const artifact = await Effect.runPromise(useArtifactBuildResult(bucket, artifactEntry));

  expect(app).toBeUndefined();
  expect(artifact?.entry.artifactRef).toBe("web:built");
});
