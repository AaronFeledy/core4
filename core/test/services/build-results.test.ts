import { describe, expect, test } from "bun:test";

import { DateTime, Schema } from "effect";

import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { BuildResultEntry, findCompleteBuildResult } from "../../src/services/build-results.ts";

const completedAt = DateTime.unsafeMake("2026-07-12T15:00:00.000Z");
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
});
