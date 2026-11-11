import { describe, expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import {
  BuildResultEntry,
  findCompleteBuildResult,
  openScratchBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const completedAt = DateTime.makeUnsafe("2026-07-12T15:00:00.000Z");
const requiredEntry = {
  buildKey: "a".repeat(64),
  service: ServiceName.make("web"),
  phase: "artifact",
  outcome: "complete",
  exitCode: 0,
  durationMs: 12,
  artifactRef: "web:test",
  transcriptPath: AbsolutePath.make("/tmp/lando/builds/web.log"),
  completedAt,
} as const;

describe("BuildResultEntry", () => {
  test("requires the transcript pointer and DateTimeUtc completion timestamp", () => {
    expect(Schema.is(BuildResultEntry)(requiredEntry)).toBe(true);
    const { transcriptPath: _, ...missingTranscript } = requiredEntry;
    expect(Schema.is(BuildResultEntry)(missingTranscript)).toBe(false);
    expect(
      Schema.is(BuildResultEntry)({
        ...requiredEntry,
        completedAt: "2026-07-12T15:00:00.000Z",
      }),
    ).toBe(false);
  });

  test("returns the newest matching complete result", () => {
    const { artifactRef: _, ...older } = requiredEntry;
    const newer = { ...requiredEntry, artifactRef: "web:newer" };
    expect(
      findCompleteBuildResult([older, newer], {
        buildKey: requiredEntry.buildKey,
        service: requiredEntry.service,
        phase: requiredEntry.phase,
      }),
    ).toEqual(newer);
  });

  test("returns nothing when a newer matching attempt failed", () => {
    // Given
    const success = requiredEntry;
    const failure = { ...requiredEntry, outcome: "fail" as const, exitCode: 1 };

    // When
    const found = findCompleteBuildResult([success, failure], {
      buildKey: requiredEntry.buildKey,
      service: requiredEntry.service,
      phase: requiredEntry.phase,
    });

    // Then
    expect(found).toBeUndefined();
  });

  test("returns a newer success recorded after a failure", () => {
    // Given
    const failure = { ...requiredEntry, outcome: "fail" as const, exitCode: 1 };
    const success = { ...requiredEntry, artifactRef: "web:newer" };

    // When
    const found = findCompleteBuildResult([failure, success], {
      buildKey: requiredEntry.buildKey,
      service: requiredEntry.service,
      phase: requiredEntry.phase,
    });

    // Then
    expect(found).toEqual(success);
  });

  test("caps the index at the newest 500 entries", async () => {
    // Given 501 recorded results whose keys are all distinct.
    const store = makeTestStateStore();
    const bucket = await Effect.runPromise(openScratchBuildResults(store.service));
    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 501 }, (_, index) => index),
        (index) =>
          recordBuildResult(bucket, {
            ...requiredEntry,
            buildKey: `entry-${String(index)}`,
          }),
        { discard: true },
      ),
    );

    // When
    const entries = await Effect.runPromise(bucket.get);

    // Then
    expect(entries).toHaveLength(500);
    expect(entries?.[0]?.buildKey).toBe("entry-1");
    expect(entries?.at(-1)?.buildKey).toBe("entry-500");
    expect(entries?.map((entry) => entry.buildKey)).toEqual(
      Array.from({ length: 500 }, (_, index) => `entry-${index + 1}`),
    );
  });
});
