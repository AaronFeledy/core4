import { expect, test } from "bun:test";
import type { SourceGcReport } from "@lando/engine/operations/source-cache-gc";
import { SourceGcReportSchema } from "@lando/source-acquisition/gc";
import { Effect, Schema } from "effect";
import {
  failOnFailedEntries,
  metaSourcesGcSpec,
  sourceGcOptionsFromInput,
} from "../../src/cli/command-specs/meta/sources/gc";
import { renderSourceGcReport } from "../../src/cli/commands/sources-gc";

const emptyReport = (overrides: Partial<SourceGcReport> = {}): SourceGcReport => ({
  prune: false,
  olderThanDays: 30,
  cutoff: new Date(0).toISOString(),
  reachability: "complete",
  roots: [],
  entries: [],
  leftovers: [],
  totals: {
    entries: 0,
    bytes: 0,
    eligible: 0,
    eligibleBytes: 0,
    removed: 0,
    removedBytes: 0,
    busy: 0,
    withheld: 0,
    failed: 0,
  },
  ...overrides,
});

test("sources:gc parses flags with defaults and aliases", () => {
  expect(sourceGcOptionsFromInput({ flags: {} })).toEqual({ prune: false, olderThanDays: 30 });
  expect(sourceGcOptionsFromInput({ flags: { prune: true, "older-than": 0 } })).toEqual({
    prune: true,
    olderThanDays: 0,
  });
  expect(sourceGcOptionsFromInput({ flags: { "older-than": 7 } })).toEqual({
    prune: false,
    olderThanDays: 7,
  });
  expect(metaSourcesGcSpec.aliases).toContain("sources:gc");
  expect(metaSourcesGcSpec.id).toBe("meta:sources:gc");
  expect(metaSourcesGcSpec.bootstrap).toBe("minimal");
  expect(metaSourcesGcSpec.flags?.yes).toBeDefined();
  expect(metaSourcesGcSpec.flags?.prune).toMatchObject({ default: false });
  expect(metaSourcesGcSpec.flags?.["older-than"]).toMatchObject({ default: 30, valueType: "integer" });
  expect(metaSourcesGcSpec.resultSchema).toBe(SourceGcReportSchema);
});

test("sources:gc renders empty, report, prune, incomplete, and prune-hint results", () => {
  expect(renderSourceGcReport(emptyReport())).toBe("No source-cache entries found.");
  expect(
    renderSourceGcReport(
      emptyReport({
        totals: {
          entries: 2,
          bytes: 2048,
          eligible: 1,
          eligibleBytes: 1024,
          removed: 0,
          removedBytes: 0,
          busy: 0,
          withheld: 0,
          failed: 0,
        },
      }),
    ),
  ).toBe(
    "2 source-cache entries (2 KiB); 1 eligible (1 KiB). Run lando sources:gc --prune to remove eligible entries.",
  );
  expect(
    renderSourceGcReport(
      emptyReport({
        prune: true,
        totals: {
          entries: 2,
          bytes: 2048,
          eligible: 2,
          eligibleBytes: 2048,
          removed: 2,
          removedBytes: 2048,
          busy: 0,
          withheld: 0,
          failed: 0,
        },
      }),
    ),
  ).toBe("Removed 2 source-cache entries (2 KiB).");
  expect(
    renderSourceGcReport(
      emptyReport({
        reachability: "incomplete",
        roots: [{ lockfile: "/app/.lando.lock.yml", status: "corrupt", detail: "bad" }],
      }),
    ),
  ).toContain("unreadable/corrupt lockfiles: /app/.lando.lock.yml");
});

test("sources:gc fails with a tagged error when totals.failed > 0", async () => {
  const report = emptyReport({
    prune: true,
    leftovers: [
      {
        kind: "staging",
        id: ".staging-dead",
        bytes: 10,
        lastUsedAt: "1970-01-01T00:00:00.000Z",
        eligible: true,
        outcome: "failed",
        reason: "permission denied",
      },
    ],
    totals: {
      entries: 1,
      bytes: 10,
      eligible: 1,
      eligibleBytes: 10,
      removed: 0,
      removedBytes: 0,
      busy: 0,
      withheld: 0,
      failed: 1,
    },
  });
  const result = await Effect.runPromise(Effect.result(failOnFailedEntries(report)));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "DataTransferError", operation: "sourceCacheGc" },
  });
  if (result._tag !== "Failure") throw new Error("Expected failed cache operation");
  expect(result.failure.message).toContain("staging/.staging-dead: permission denied");
  expect(await Effect.runPromise(failOnFailedEntries(emptyReport()))).toEqual(emptyReport());
});

test("sources:gc result schema accepts a full report shape", () => {
  const report = emptyReport({
    prune: true,
    olderThanDays: 0,
    reachability: "incomplete",
    roots: [{ lockfile: "/app/.lando.lock.yml", status: "unreadable", detail: "denied" }],
    entries: [
      {
        kind: "archive",
        id: "a".repeat(64),
        bytes: 12,
        lastUsedAt: new Date(0).toISOString(),
        valid: true,
        protected: false,
        leased: false,
        eligible: true,
        outcome: "removed",
      },
    ],
    leftovers: [],
    totals: {
      entries: 1,
      bytes: 12,
      eligible: 1,
      eligibleBytes: 12,
      removed: 1,
      removedBytes: 12,
      busy: 0,
      withheld: 0,
      failed: 0,
    },
  });
  expect(Schema.decodeUnknownSync(SourceGcReportSchema)(report)).toEqual(report);
});
