import { expect, test } from "bun:test";
import type { DoctorReport } from "../../src/cli/commands/doctor-contract";
import { buildDoctorReportSummary, renderDoctorReport } from "../../src/cli/commands/doctor-render-text";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report";
import type { RenderContext } from "../../src/cli/renderer-boundary";

const cases: ReadonlyArray<{
  readonly name: string;
  readonly contexts: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly identities: string;
}> = [
  {
    name: "app-listener",
    contexts: [
      { app: "demo", service: "web", port: "80" },
      { app: "demo", service: "web", port: "81" },
      { app: "demo", service: "database", port: "3306" },
    ],
    identities: "service: web, port: 80; service: web, port: 81; service: database, port: 3306",
  },
  {
    name: "host-proxy-state",
    contexts: [
      { workerState: "malformed", statePath: "/workers/one" },
      { workerState: "malformed", statePath: "/workers/two" },
    ],
    identities: "statePath: /workers/one; statePath: /workers/two",
  },
  {
    name: "journal-check",
    contexts: [
      { appRoot: "/shared", journalPath: "/journals/one" },
      { appRoot: "/shared", journalPath: "/journals/two" },
    ],
    identities: "journalPath: /journals/one; journalPath: /journals/two",
  },
];

test.each(cases)(
  "identifies grouped $name records by the fields that distinguish them",
  ({ name, contexts, identities }) => {
    const report: DoctorReport = makeDoctorReport({
      version: "4.2.0",
      checks: contexts.map((context) => ({
        section: "subsystems" as const,
        name,
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
    const tty: RenderContext = { mode: "lando", format: "text", isTTY: true, columns: 120, noColor: true };
    for (const surface of [undefined, tty]) {
      const text = renderDoctorReport(report, surface);
      for (const identity of identities.split("; ")) expect(text).toContain(identity);
    }
  },
);
