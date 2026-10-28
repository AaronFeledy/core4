import { expect, it } from "bun:test";
import { Effect } from "effect";
import { inspectWorkflow } from "../src/inspect.ts";

for (const [content, code, rule, path, line] of [
  ["on: push", "workflow-required", "required", ["workflow", "jobs"], 1],
  [
    "on: push\njobs:\n  build:\n    steps: []",
    "workflow-required",
    "required",
    ["workflow", "jobs", "runs-on"],
    4,
  ],
  ["on: push\non: push\njobs: {}", "workflow-duplicate-key", "duplicate-key", ["workflow", "on"], 2],
  [
    "on: push\nPRIVATE_SENTINEL: PRIVATE_VALUE\njobs: {}",
    "workflow-unknown-key",
    "unknown-key",
    ["workflow"],
    2,
  ],
  [
    "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: PRIVATE_VALUE",
    "workflow-type",
    "type",
    ["workflow", "jobs", "steps"],
    5,
  ],
] as const) {
  it(`reports ${rule} at a known structural path without authored values`, async () => {
    const result = await Effect.runPromise(inspectWorkflow(".github/workflows/ci.yml", content));
    expect(result.diagnostics[0]).toMatchObject({ code, rule, path, source: { line } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
}

it("does not call an invalid scalar value an unknown key", async () => {
  const result = await Effect.runPromise(
    inspectWorkflow(".github/workflows/ci.yml", "on: PRIVATE_SENTINEL\njobs: {}"),
  );
  expect(result.diagnostics[0]).toMatchObject({
    code: "workflow-invalid",
    rule: "value",
    path: ["workflow", "on"],
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});
