import { expect, test } from "bun:test";
import { ToolingCompileError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report";

test("text tooling failures bound expanded secrets and omit whole locations", () => {
  const error = new ToolingCompileError({
    tool: "run",
    source: { path: `/app/${"xy".repeat(2000)}.yml`, task: "run" },
    message: "Invalid xy ".repeat(200),
    remediation: "Correct xy ".repeat(200),
    omittedIssueCount: 3,
    issues: Array.from({ length: 10 }, (_, index) => ({
      path: ["tooling", "run", index],
      message: "xy ".repeat(300),
      source: { layer: "canonical" as const, file: "/app/whole.yml", path: ["tooling", "run", index] },
    })),
  });
  const report = buildBugReport({
    error,
    redactor: createRedactor("secrets", { values: ["xy"] }),
    context: { commandId: "app:run", cacheRoot: "/tmp/cache" },
  });
  const output = renderPlainBugReport(report, { usage: true });
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024);
  expect(Buffer.byteLength(report.body)).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(report.remediation)).toBeLessThanOrEqual(1024);
  expect(report.issues?.map((issue) => issue.path.at(-1))).toEqual([0, 1, 2, 3]);
  expect(report.extra).toContainEqual(["omittedIssueCount", "9"]);
  expect(report.extra.some(([key]) => key === "source")).toBe(false);
  expect(output).not.toContain("xy");
  expect(output.match(/\/app\/whole\.yml/gu)).toHaveLength(4);
});
