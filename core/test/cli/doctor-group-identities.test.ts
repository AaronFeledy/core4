import { expect, test } from "bun:test";
import type { DoctorReport } from "../../src/cli/commands/doctor-contract";
import { buildDoctorReportSummary, renderDoctorReport } from "../../src/cli/commands/doctor-render-text";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report";
import type { RenderContext } from "../../src/cli/renderer-boundary";

const cases: ReadonlyArray<{
  readonly name: string;
  readonly contexts: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly subjects: ReadonlyArray<string>;
  readonly identities: string;
}> = [
  {
    name: "app-listener",
    contexts: [
      { app: "demo", service: "web", port: "80" },
      { app: "demo", service: "web", port: "81" },
      { app: "demo", service: "database", port: "3306" },
    ],
    subjects: ["demo/web:80", "demo/web:81", "demo/database:3306"],
    identities: "demo/web:80; demo/web:81; demo/database:3306",
  },
  {
    name: "host-proxy-state",
    contexts: [
      { workerState: "malformed", statePath: "/workers/one" },
      { workerState: "malformed", statePath: "/workers/two" },
    ],
    subjects: ["/workers/one", "/workers/two"],
    identities: "/workers/one; /workers/two",
  },
  {
    name: "journal-check",
    contexts: [
      { appRoot: "/shared", journalPath: "/journals/one" },
      { appRoot: "/shared", journalPath: "/journals/two" },
    ],
    subjects: ["/journals/one", "/journals/two"],
    identities: "/journals/one; /journals/two",
  },
];

test.each(cases)(
  "identifies grouped $name records by their explicit subjects",
  ({ name, contexts, subjects, identities }) => {
    const report: DoctorReport = makeDoctorReport({
      version: "4.2.0",
      checks: contexts.map((context, index) => ({
        section: "subsystems" as const,
        name,
        ...(subjects[index] === undefined ? {} : { subject: subjects[index] }),
        context,
        status: "warn" as const,
        severity: "warn" as const,
        recovery: "manual" as const,
        solutions: [],
      })),
      skipped: [],
    });
    const rows = buildDoctorReportSummary(report).sections.find(
      (section) => section.title === "subsystems",
    )?.rows;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.fields).toContainEqual({ label: "entries", value: identities });
    expect(
      rows?.[0]?.fields?.some((field) => ["port", "journalPath", "statePath"].includes(field.label)),
    ).toBe(false);
    const tty: RenderContext = { mode: "lando", format: "text", isTTY: true, columns: 120, noColor: true };
    for (const surface of [undefined, tty]) {
      const text = renderDoctorReport(report, surface);
      for (const identity of identities.split("; ")) expect(text).toContain(identity);
    }
  },
);

test("falls back to finding names when grouped members have no subject", () => {
  const report = makeDoctorReport({
    version: "4.2.0",
    checks: ["one", "two", "three", "four"].map((root) => ({
      section: "subsystems" as const,
      name: "custom",
      status: "warn" as const,
      severity: "warn" as const,
      context: { root, common: ["same", "values"] },
      solutions: [],
    })),
    skipped: [],
  });
  const rows = buildDoctorReportSummary(report).sections[0]?.rows;
  expect(rows?.[0]?.fields).toEqual([
    { label: "entries", value: "custom; custom; custom" },
    { label: "remaining", value: "+1 more (lando doctor --all)" },
    { label: "common", value: "same, values" },
  ]);
});
