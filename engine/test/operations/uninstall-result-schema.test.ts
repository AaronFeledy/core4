import { expect, test } from "bun:test";
import { Schema } from "effect";
import { UninstallResultSchema } from "../../src/operations/uninstall.ts";

const step = { id: "resource", label: "resource", target: "/resource", destructive: true, detail: "remove" };
const result = { dryRun: false, refused: false, mode: "purge", failed: false };

test.each([
  { status: "skipped", outcome: "failed", error: "failure" },
  { status: "skipped", outcome: "completed" },
  { status: "user-owned", outcome: "completed" },
  { status: "manual", outcome: "skipped" },
  { status: "owned", outcome: "completed", error: "failure" },
  { status: "owned", outcome: "manual", error: "failure" },
  { status: "owned", outcome: "failed" },
  { status: "owned", error: "failure" },
])("uninstall result rejects contradictory step %j", (fields) => {
  expect(
    Schema.decodeUnknownOption(UninstallResultSchema)({ ...result, steps: [{ ...step, ...fields }] })._tag,
  ).toBe("None");
});
