import { expect, test } from "bun:test";
import type { DoctorReport } from "../../src/cli/commands/doctor-report-contract";
import { buildDoctorReportSummary, renderDoctorReport } from "../../src/cli/commands/doctor-report-render";
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
    const report: DoctorReport = {
      version: "4.2.0",
      provider: { checks: [] },
      globalApp: { checks: [] },
      mcp: { checks: [] },
      subsystems: {
        checks: contexts.map((context) => ({
          name,
          context,
          status: "warn",
          severity: "warn",
          recovery: "manual",
          solutions: [],
        })),
      },
    };
    const rows = buildDoctorReportSummary(report).sections[0]?.rows;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.fields).toContainEqual({ label: "entries", value: identities });
    const tty: RenderContext = { mode: "lando", format: "text", isTTY: true, columns: 120, noColor: true };
    for (const surface of [undefined, tty]) {
      const text = renderDoctorReport(report, surface);
      for (const identity of identities.split("; ")) expect(text).toContain(identity);
    }
  },
);
