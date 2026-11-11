import { expect, test } from "bun:test";
import { Schema } from "effect";
import { GcEntry, GcLeftover } from "../src/gc-schema.ts";
import { EntryRecord } from "../src/records.ts";

test.each([
  { kind: "git", id: "a".repeat(40), treeDigest: "b".repeat(64), valid: true },
  { kind: "archive", id: "a".repeat(64), treeDigest: "b".repeat(64), valid: true },
  { kind: "git", id: "a".repeat(64), treeDigest: "b".repeat(64), valid: false },
  { kind: "archive", id: "a".repeat(40), treeDigest: "b".repeat(64), valid: false },
  { kind: "archive", id: "a".repeat(64), treeDigest: "bad", valid: false },
])(
  "entry record binds its kind to its identity and tree digest ($kind, $valid)",
  ({ valid, ...identity }) => {
    expect(
      Schema.is(EntryRecord)({ version: 1, format: 1, ...identity, provenance: { source: "fixture" } }),
    ).toBe(valid);
  },
);

test.each([
  { protected: false, leased: false, eligible: true, outcome: "kept", valid: true },
  { protected: true, leased: false, eligible: true, outcome: "kept", valid: false },
  { protected: false, leased: true, eligible: true, outcome: "kept", valid: false },
  { protected: false, leased: false, eligible: true, outcome: "busy", valid: false },
  { protected: false, leased: false, eligible: true, outcome: "withheld", valid: false },
  { protected: false, leased: true, eligible: false, outcome: "busy", valid: true },
])(
  "GC eligibility cannot contradict protection ($outcome, $protected, $leased)",
  ({ valid, ...observation }) => {
    expect(
      Schema.is(GcEntry)({
        kind: "archive",
        id: "a".repeat(64),
        bytes: 1,
        lastUsedAt: "2026-01-01T00:00:00Z",
        valid: true,
        ...observation,
      }),
    ).toBe(valid);
  },
);

test.each(["busy", "withheld"])("GC cannot mark a %s leftover eligible", (outcome) => {
  const row = { kind: "lease", id: "lease.json", bytes: 1, lastUsedAt: "2026-01-01T00:00:00Z", outcome };
  expect(Schema.is(GcLeftover)({ ...row, eligible: true })).toBe(false);
  expect(Schema.is(GcLeftover)({ ...row, eligible: false })).toBe(true);
});
