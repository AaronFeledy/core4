import { describe, expect, it } from "bun:test";
import { renderInspection } from "../src/render.ts";
import type {
  InspectedWorkflow,
  InspectionJob,
  WorkflowDiagnostic,
  WorkflowInspection,
} from "../src/schema.ts";

// ==== Fixtures: real inspection values, no runtime services.
const path = ".github/workflows/ci.yml";
const nightly = ".github/workflows/nightly.yml";
type Step = InspectionJob["steps"][number];
const step = (category: Step["category"], line: number): Step => ({
  source: { workflow: path, line, column: 9 },
  category,
});
const job = (overrides: Partial<InspectionJob> = {}): InspectionJob => ({
  id: "build",
  source: { workflow: path, line: 4, column: 3 },
  kind: "job",
  needs: [],
  runnerLabels: ["ubuntu-latest"],
  runnerAssessment: "literal",
  matrix: "absent",
  steps: [step("repository-action", 7), step("script", 9)],
  ...overrides,
});
const finding = (overrides: Partial<WorkflowDiagnostic> = {}): WorkflowDiagnostic => ({
  code: "workflow-required",
  severity: "error",
  source: { workflow: path, line: 5, column: 5 },
  path: ["workflow", "jobs", "runs-on"],
  field: "runs-on",
  rule: "required",
  remediation: "Add the required runs-on property at the indicated mapping.",
  ...overrides,
});
const fileLevel = (
  code: WorkflowDiagnostic["code"],
  workflow: string,
  remediation: string,
): WorkflowDiagnostic => ({
  code,
  severity: "error",
  source: { workflow },
  remediation,
});
const workflow = (overrides: Partial<InspectedWorkflow> = {}): InspectedWorkflow => ({
  source: { workflow: path, line: 1, column: 1 },
  status: "inspected",
  name: "Checks",
  triggers: ["pull_request", "push"],
  jobs: [job()],
  diagnostics: [],
  diagnosticsTruncated: false,
  ...overrides,
});
const uninspected = (workflow: string, diagnostics: readonly WorkflowDiagnostic[]): InspectedWorkflow => ({
  source: { workflow },
  status: "uninspected",
  triggers: [],
  jobs: [],
  diagnostics,
  diagnosticsTruncated: false,
});
const inspection = (workflows: readonly InspectedWorkflow[]): WorkflowInspection => {
  const total = (status: InspectedWorkflow["status"]) =>
    workflows.filter((row) => row.status === status).length;
  return {
    workflows,
    summary: {
      discovered: workflows.length,
      inspected: total("inspected"),
      failed: total("failed"),
      uninspected: total("uninspected"),
    },
    complete: total("uninspected") === 0,
    diagnosticsTruncated: workflows.some((row) => row.diagnosticsTruncated),
    assessment: "execution-unassessed",
  };
};
const lines = (output: string) => output.split("\n");
const occurrences = (output: string, needle: string) => output.split(needle).length - 1;

describe("renderInspection", () => {
  it("renders a short actionable empty state when nothing was discovered", () => {
    const output = renderInspection(inspection([]));
    expect(lines(output)).toHaveLength(3);
    expect(output).toContain("0 workflows");
    expect(output).toContain("No workflow files found in .github/workflows");
    expect(output).toContain("--root <directory>");
    expect(output).not.toContain("no errors");
    expect(output).not.toContain("Next:");
  });

  it("summarizes, names the workflow once, and keeps one job on one short row when healthy", () => {
    const only = job({
      id: "static-checks-platform",
      runnerLabels: ["ubuntu-26.04"],
      source: { workflow: path, line: 20 },
    });
    const output = renderInspection(inspection([workflow({ jobs: [only] })]));
    expect(lines(output)[0]).toBe("GitHub Actions (offline): 1 workflow, 1 job, no errors");
    expect(output).toContain(`${path}  Checks  ok`);
    expect(output).toContain("  on: pull_request, push");
    const row = lines(output).find((line) => line.includes("static-checks-platform"));
    expect(row).toBe("  20 | static-checks-platform  ubuntu-26.04  1 script, 1 action");
    expect(occurrences(output, path)).toBe(1);
    expect(occurrences(output, "Nothing was executed")).toBe(1);
    expect(output).not.toContain("Next:");
  });

  it("groups step categories into counts instead of listing every step location", () => {
    const steps = [
      ...Array.from({ length: 15 }, (_, index) => step("script", 10 + index)),
      step("repository-action", 40),
      step("local-action", 41),
      step("container-action", 42),
      step("unresolved-action", 43),
      step("unassessed", 44),
    ];
    const output = renderInspection(
      inspection([workflow({ jobs: [job({ steps }), job({ id: "lint", steps: [step("script", 60)] })] })]),
    );
    expect(output).toContain(
      "15 scripts, 1 action, 1 local action, 1 container action, 1 dynamic action, 1 unassessed step",
    );
    expect(output).toContain("| lint  ubuntu-latest  1 script");
    expect(output).not.toMatch(/\d+:\d+\)/u);
  });

  it("notes dynamic runners, matrices, reusable calls, and dependencies compactly", () => {
    const jobs = [
      job({
        id: "shard",
        runnerLabels: [],
        runnerAssessment: "unresolved",
        matrix: "unassessed",
        needs: ["build"],
      }),
      job({ id: "grouped", runnerLabels: ["self-hosted"], runnerAssessment: "unresolved" }),
      job({
        id: "deploy",
        kind: "reusable-workflow",
        runnerLabels: [],
        runnerAssessment: "unassessed",
        steps: [],
      }),
      job({ id: "gate", needs: ["a", "b", "c", "d", "e", "f", "g", "h"] }),
      job({ id: "six", needs: ["a", "b", "c", "d", "e", "f"] }),
    ];
    const output = renderInspection(inspection([workflow({ jobs })]));
    const rows = lines(output);
    expect(rows).toContain("  4 | shard  matrix  dynamic runner  1 script, 1 action");
    expect(rows).toContain("    |   needs: build");
    expect(output).toContain("| grouped  dynamic runner (self-hosted)  ");
    expect(output).toContain("| deploy  reusable workflow (not fetched)");
    expect(output).not.toContain("runner unassessed");
    expect(rows).toContain("    |   needs: a, b, c, d, e, and 3 more");
    expect(rows).toContain("    |   needs: a, b, c, d, e, f");
  });

  it("prints precise references per occurrence and each remediation once for a failed workflow", () => {
    const diagnostics = [
      finding({ source: { workflow: nightly, line: 5, column: 5 } }),
      finding({ source: { workflow: nightly, line: 14, column: 5 } }),
      finding({
        code: "workflow-invalid",
        rule: "expression",
        path: ["workflow", "on"],
        field: "on",
        source: { workflow: nightly, line: 2, column: 5 },
        remediation: "Correct the expression.",
      }),
      fileLevel("yaml-alias", nightly, "Replace YAML aliases with explicit values."),
    ];
    const failed: InspectedWorkflow = {
      source: { workflow: nightly },
      status: "failed",
      triggers: [],
      jobs: [],
      diagnostics,
      diagnosticsTruncated: false,
    };
    const output = renderInspection(inspection([workflow(), failed]));
    const rows = lines(output);
    expect(rows[0]).toBe("GitHub Actions (offline): 2 workflows, 1 job, 1 with errors");
    expect(rows).toContain(`${nightly}  4 errors`);
    expect(rows).toContain(`  ${nightly}:5:5  workflow-required in jobs.runs-on`);
    expect(rows).toContain(`  ${nightly}:14:5  workflow-required in jobs.runs-on`);
    expect(occurrences(output, "Add the required runs-on property")).toBe(1);
    expect(rows).toContain(`  ${nightly}:2:5  workflow-invalid (expression) in on`);
    expect(rows.filter((row) => row.includes("yaml-alias"))).toEqual(["  yaml-alias"]);
    expect(occurrences(output, "Nothing was executed")).toBe(1);
  });

  it("wraps remediation prose at 78 columns without splitting words", () => {
    const remediation = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
    const output = renderInspection(
      inspection([workflow({ status: "failed", jobs: [], diagnostics: [finding({ remediation })] })]),
    );
    const prose = lines(output).filter((row) => row.startsWith("    word"));
    expect(prose.length).toBeGreaterThan(1);
    for (const row of prose) expect(row.length).toBeLessThanOrEqual(78);
    expect(prose.map((row) => row.trim()).join(" ")).toBe(remediation);
  });

  it("marks truncated diagnostics and incomplete inspection with an exact narrowing command", () => {
    const diagnostics = Array.from({ length: 50 }, (_, index) =>
      finding({ source: { workflow: path, line: index + 1, column: 1 } }),
    );
    const big = ".github/workflows/big.yml";
    const output = renderInspection(
      inspection([
        workflow({ status: "failed", jobs: [], diagnostics, diagnosticsTruncated: true }),
        uninspected(big, [fileLevel("aggregate-limit", big, "Inspect fewer workflows using --workflow.")]),
      ]),
    );
    const rows = lines(output);
    expect(rows[0]).toContain("1 with errors, 1 not inspected");
    expect(rows).toContain(`${path}  Checks  50+ errors`);
    expect(output).toContain("Only the first 50 errors are shown");
    expect(rows).toContain(`${big}  not inspected`);
    expect(rows).toContain("  aggregate-limit");
    expect(rows.at(-1)).toBe(`  lando github-actions:list --workflow ${big}`);
  });

  it("falls back to a marked placeholder when the pending path is not shell-safe", () => {
    const unsafe = ".github/workflows/it's big.yml";
    const output = renderInspection(inspection([uninspected(unsafe, [])]));
    expect(output).toContain(`${unsafe}  not inspected`);
    expect(output).toContain("  lando github-actions:list --workflow <path>");
    expect(output).not.toContain(`--workflow ${unsafe}`);
    expect(output).not.toContain(`--workflow '${unsafe}'`);
  });

  it("escapes terminal and bidi controls from every projected field", () => {
    const hostile = "\u001b[31mred\u001b[0m\u202e";
    const source = { workflow: `.github/workflows/${hostile}.yml`, line: 3, column: 1 };
    const output = renderInspection(
      inspection([
        workflow({
          source,
          name: hostile,
          triggers: [hostile],
          jobs: [job({ id: hostile, needs: [hostile], runnerLabels: [hostile] })],
          status: "failed",
          diagnostics: [finding({ source, remediation: `fix\u2028${hostile}` })],
        }),
      ]),
    );
    for (const row of lines(output)) expect(row).toMatch(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
    expect(output).toContain("\\u{1b}[31mred\\u{1b}[0m\\u{202e}");
  });
});
