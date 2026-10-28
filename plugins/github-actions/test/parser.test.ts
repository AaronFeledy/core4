import { expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { inspectWorkflow } from "../src/inspect.ts";
import { listWorkflows } from "../src/operations.ts";
import { WorkflowInspection } from "../src/schema.ts";
import { repository, validWorkflow } from "./fixtures.ts";

it("projects literal trigger, dependency, runner, and step facts with source positions", async () => {
  const content = `name: Checks
on: [push, workflow_dispatch]
jobs:
  prepare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  build:
    needs: prepare
    runs-on: [self-hosted, linux]
    steps:
      - run: echo PRIVATE_SCRIPT
      - uses: ./PRIVATE_LOCAL
      - uses: docker://PRIVATE_IMAGE
`;
  const result = await Effect.runPromise(inspectWorkflow(".github/workflows/ci.yml", content));
  expect(result.status).toBe("inspected");
  expect(result.triggers).toEqual(["push", "workflow_dispatch"]);
  expect(result.jobs[1]).toMatchObject({
    id: "build",
    needs: ["prepare"],
    runnerLabels: ["self-hosted", "linux"],
    runnerAssessment: "literal",
    source: { line: 8, column: 3 },
  });
  expect(result.jobs[1]?.steps.map((step) => step.category)).toEqual([
    "script",
    "local-action",
    "container-action",
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
});

it("leaves expressions, matrix, and reusable workflow bodies unresolved", async () => {
  const content = `on: push
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: echo hello
  shared:
    uses: owner/repo/.github/workflows/PRIVATE.yml@main
`;
  const result = await Effect.runPromise(inspectWorkflow(".github/workflows/ci.yml", content));
  expect(result.status).toBe("inspected");
  expect(result.jobs[0]).toMatchObject({
    matrix: "unassessed",
    runnerAssessment: "unresolved",
    runnerLabels: [],
  });
  expect(result.jobs[1]).toMatchObject({
    kind: "reusable-workflow",
    steps: [],
    runnerAssessment: "unassessed",
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

for (const [label, content, code] of [
  ["syntax", "on: [push\njobs: {}", "yaml-syntax"],
  ["duplicate keys", "on: push\non: pull_request\njobs: {}", "workflow-duplicate-key"],
  [
    "bad expression",
    validWorkflow.replace("echo PRIVATE_SCRIPT", "${{ PRIVATE_SENTINEL( }}"),
    "workflow-invalid",
  ],
  ["unknown keys", "PRIVATE_SENTINEL: PRIVATE_VALUE\non: push\njobs: {}", "workflow-unknown-key"],
  ["deep YAML", `on: push\nenv: ${"[".repeat(70)}0${"]".repeat(70)}\njobs: {}`, "yaml-depth"],
  ["large YAML", `on: push\nenv: [${"a,".repeat(50_001)}]\njobs: {}`, "yaml-nodes"],
  ["alias", "on: &a push\nname: *a\njobs: {}", "yaml-alias"],
  ["circular alias", "on: push\nenv: &a [*a]\njobs: {}", "yaml-alias"],
  ["reused alias", "on: push\nenv: &a {a: b}\nx: [*a,*a,*a]\njobs: {}", "yaml-alias"],
] as const) {
  it(`reports a safe bounded diagnostic when parsing ${label}`, async () => {
    const result = await Effect.runPromise(inspectWorkflow(".github/workflows/ci.yml", content));
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(result.diagnostics[0]?.remediation.length).toBeGreaterThan(0);
  });
}

it("keeps alias-looking text opaque inside multiline scripts", async () => {
  const result = await Effect.runPromise(
    inspectWorkflow(
      ".github/workflows/ci.yml",
      validWorkflow.replace(
        "echo PRIVATE_SCRIPT",
        "|\n          echo '*alias &anchor'\n          echo PRIVATE_SCRIPT",
      ),
    ),
  );
  expect(result.status).toBe("inspected");
  expect(result.jobs[0]?.steps[0]?.category).toBe("script");
});

it("caps authoritative validation diagnostics and declares truncation", async () => {
  const content = `on: push\njobs:\n${Array.from({ length: 70 }, (_, index) => `  j${index}:\n    PRIVATE_${index}: nope\n    runs-on: ubuntu-latest\n    steps: []`).join("\n")}`;
  const result = await Effect.runPromise(inspectWorkflow(".github/workflows/ci.yml", content));
  expect(result.diagnostics).toHaveLength(50);
  expect(result.diagnosticsTruncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
});

it("escapes terminal controls in essential metadata and round-trips the report", async () => {
  await using repo = await repository({
    "ci.yml": validWorkflow.replace("Checks", '"Check\\u001b[31m\\u202e"'),
  });
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.workflows[0]?.name).toBe("Check\\u{1b}[31m\\u{202e}");
  expect(
    Schema.decodeUnknownSync(WorkflowInspection)(JSON.parse(JSON.stringify(result)), {
      onExcessProperty: "error",
    }),
  ).toEqual(result);
});
