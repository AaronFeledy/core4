import { expect, test } from "bun:test";
import { ToolingRunSummary } from "@lando/sdk/schema";
import { Schema } from "effect";
import { decodeAppCommandIndex } from "../../src/cache/command-index.ts";
import { app, currentAbiBytes, entry } from "./fixtures/command-index-codec.ts";

test.each([
  { kind: "commands", steps: 1, targets: [{ kind: "host" }], program: "echo" },
  {
    kind: "commands",
    steps: 1000,
    targets: [
      { kind: "service", name: "web" },
      { kind: "flag", flag: "service" },
      { kind: "primary" },
      { kind: "dynamic" },
    ],
  },
  { kind: "script", path: ".lando/scripts/deploy.bun.sh" },
])("roundtrips SDK-encoded run summaries %#", (runs) => {
  const encoded = Schema.encodeSync(ToolingRunSummary)(Schema.decodeUnknownSync(ToolingRunSummary)(runs));
  const payload = { ...app, entries: [{ ...entry, runs: encoded }] };
  expect(decodeAppCommandIndex(currentAbiBytes("LCAC", payload))).toEqual(payload);
});

test.each([
  null,
  {},
  { kind: "other" },
  { kind: "script", path: "x".repeat(513) },
  ...[0, 1001, 1.5, Number.NaN].map((steps) => ({ kind: "commands", steps, targets: [{ kind: "host" }] })),
  ...[
    [],
    new Array(1),
    [{ kind: "bad" }],
    [{ kind: "service" }],
    [{ kind: "flag", flag: null }],
    [{ kind: "host" }, { kind: "host" }],
    Array.from({ length: 33 }, (_, i) => ({ kind: "service", name: `s${i}` })),
  ].map((targets) => ({ kind: "commands", steps: 1, targets })),
  ...["", "x".repeat(65), null].map((program) => ({
    kind: "commands",
    steps: 1,
    targets: [{ kind: "host" }],
    program,
  })),
])("rejects run summaries outside the public contract %#", (runs) => {
  expect(Schema.is(ToolingRunSummary)(runs)).toBe(false);
  expect(
    decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [{ ...entry, runs }] })),
  ).toBeNull();
});
