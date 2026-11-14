import { expect, test } from "bun:test";
import type { DoctorSectionFinding, DoctorStatus } from "../../src/cli/commands/doctor-contract";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson";
import { buildDoctorReportSummary } from "../../src/cli/commands/doctor-render-text";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report-model";
import { selectDoctorView } from "../../src/cli/commands/doctor-view";

const finding = (subject: string, status: DoctorStatus = "warn"): DoctorSectionFinding => ({
  section: "missing-app-roots",
  name: "missing-app-root",
  subject,
  status,
  severity: "warn",
  context: {},
  solutions: [],
});
const reportFrom = (checks: ReadonlyArray<DoctorSectionFinding>) => makeDoctorReport({ checks, skipped: [] });

test("assigns section/name/subject ids once and disambiguates all collisions in report order", () => {
  const singleton: DoctorSectionFinding = {
    section: "mcp",
    name: "mcp",
    status: "pass",
    severity: "info",
    context: {},
    solutions: [],
  };
  const report = reportFrom([singleton, singleton, finding("a"), finding("a"), finding("a"), finding("a#2")]);
  expect(report.checks.map((check) => check.id)).toEqual([
    "mcp/mcp",
    "mcp/mcp#2",
    "missing-app-roots/missing-app-root/a",
    "missing-app-roots/missing-app-root/a#2",
    "missing-app-roots/missing-app-root/a#3",
    "missing-app-roots/missing-app-root/a#2#2",
  ]);
  expect(selectDoctorView(report, { statuses: ["pass"] }).checks.map((check) => check.id)).toEqual([
    "mcp/mcp",
    "mcp/mcp#2",
  ]);
});

test("filters statuses without reordering or paging and retains the whole report summary", () => {
  const report = reportFrom([finding("z", "warn"), finding("a", "pass"), finding("b", "fail")]);
  const view = selectDoctorView(report, { statuses: ["fail", "warn"] });
  expect(view.checks.map((check) => check.subject)).toEqual(["z", "b"]);
  expect(view.page).toBeUndefined();
  expect(view.summary).toEqual({ checks: 3, passed: 1, warned: 1, failed: 1, selfFailed: 0 });
  expect(report.checks).toHaveLength(3);
});

test("pages by section order and plain string id comparison, with filtered totals and next only when needed", () => {
  const report = reportFrom([
    finding("z"),
    finding("a"),
    finding("B"),
    finding("hidden", "pass"),
    { ...finding("z"), section: "provider" },
  ]);
  const first = selectDoctorView(report, { statuses: ["warn"], limit: 2 });
  expect(first.checks.map((check) => check.id)).toEqual([
    "provider/missing-app-root/z",
    "missing-app-roots/missing-app-root/B",
  ]);
  expect(first.page).toEqual({ limit: 2, matched: 4, next: "missing-app-roots/missing-app-root/B" });
  const last = selectDoctorView(report, { statuses: ["warn"], limit: 2, after: first.page?.next });
  expect(last.checks.map((check) => check.subject)).toEqual(["a", "z"]);
  expect(last.page).toEqual({ limit: 2, matched: 4 });
  expect(
    selectDoctorView(report, { limit: 2, after: "missing-app-roots/missing-app-root/zz" }).checks,
  ).toEqual([]);
});

test.each([1, 2, 3, 5])(
  "#2201 keyset pages retain every surviving id exactly once across changed runs (limit %i)",
  (limit) => {
    const original = Array.from({ length: 12 }, (_, index) => finding(String(index).padStart(2, "0")));
    const reportA = reportFrom(original);
    const first = selectDoctorView(reportA, { limit });
    const cursor = first.page?.next;
    expect(cursor).toBeDefined();
    const reportB = reportFrom([
      finding("-1-before"),
      ...original
        .filter((check) => check.subject !== String(limit - 1).padStart(2, "0"))
        .map((check) => (check.subject === "10" ? { ...check, status: "pass" as const } : check)),
      finding("99-after"),
    ]);
    const seen = first.checks.map((check) => check.id);
    let after = cursor;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = selectDoctorView(reportB, { limit, after });
      seen.push(...page.checks.map((check) => check.id));
      after = page.page?.next;
      if (after === undefined) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const surviving = reportA.checks.filter((check) => reportB.checks.some((other) => other.id === check.id));
    for (const check of surviving) expect(seen.filter((id) => id === check.id)).toHaveLength(1);
  },
);

test("NDJSON terminal frame carries page while check payloads carry ids", () => {
  const view = selectDoctorView(reportFrom([finding("a"), finding("b")]), { limit: 1 });
  const frames = renderDoctorReportAsNdjson(view)
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(frames[0]).toMatchObject({
    event: "doctor.check",
    payload: { id: "missing-app-roots/missing-app-root/a" },
  });
  expect(frames.at(-1)).toMatchObject({
    envelope: { result: { page: { limit: 1, matched: 2, next: "missing-app-roots/missing-app-root/a" } } },
  });
});

test("text continuation repeats the selection and quotes a cursor subject containing spaces", () => {
  const view = selectDoctorView(reportFrom([finding("a b"), finding("z")]), { limit: 1 });
  const summary = buildDoctorReportSummary(view, {
    selection: ["--section", "missing-app-roots", "--status", "fail", "--status", "warn"],
  });
  expect(summary.nextSteps).toEqual([
    "lando doctor --format=json --section missing-app-roots --status fail --status warn --limit 1 --after 'missing-app-roots/missing-app-root/a b'",
  ]);
  expect(summary.footer).toContain("2 checks");
});
