import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "../../src/cli/renderer/console-layout.ts";
import { type SummaryDocument, formatSummary } from "../../src/cli/renderer/summary.ts";

const linesOf = (text: string): ReadonlyArray<string> => text.split("\n");

const sampleDoc: SummaryDocument = {
  title: "UNINSTALL PLAN",
  tone: "warn",
  subtitle: "dry-run · keep-data",
  sections: [
    {
      title: "toolchain",
      rows: [
        {
          label: "managed provider runtime",
          tone: "skipped",
          value: "skipped",
          detail: "Remove Lando-managed runtime bundles when present.",
          fields: [{ label: "target", value: "/home/u/.local/share/lando/providers/lando" }],
        },
        { label: "installed binary", tone: "ok", value: "owned by Lando" },
      ],
    },
  ],
  nextSteps: ["Rerun `lando uninstall --yes` after reviewing this plan."],
  footer: "11 steps reviewed",
};

describe("formatSummary", () => {
  test("frames the document as an aligned box at the given width", () => {
    const out = formatSummary(sampleDoc, { columns: 60 });
    const lines = linesOf(out);
    for (const line of lines) expect(displayWidth(line)).toBe(60);
    expect(stripAnsi(lines[0] ?? "").startsWith("╭─ UNINSTALL PLAN ")).toBe(true);
    expect(stripAnsi(lines[lines.length - 1] ?? "").endsWith("╯")).toBe(true);
  });

  test("renders status chips as readable text, never color-only", () => {
    const out = stripAnsi(formatSummary(sampleDoc, { columns: 80 }));
    expect(out).toContain("[SKIP]");
    expect(out).toContain("[OK]");
  });

  test("includes section heading, next steps, and footer", () => {
    const out = stripAnsi(formatSummary(sampleDoc, { columns: 80 }));
    expect(out).toContain("toolchain");
    expect(out).toContain("next steps");
    expect(out).toContain("Rerun `lando uninstall --yes`");
    expect(out).toContain("11 steps reviewed");
  });

  test("keeps every line within a narrow terminal width", () => {
    const out = formatSummary(sampleDoc, { columns: 40 });
    for (const line of linesOf(out)) expect(displayWidth(line)).toBe(40);
  });

  test("aligns wide/CJK content without overflowing the frame", () => {
    const doc: SummaryDocument = {
      title: "APP INFO",
      sections: [
        {
          title: "services",
          rows: [
            { label: "你好世界-service", tone: "ok", value: "running" },
            { label: "데이터베이스", tone: "warn", value: "starting" },
          ],
        },
      ],
    };
    const out = formatSummary(doc, { columns: 50 });
    for (const line of linesOf(out)) expect(displayWidth(line)).toBe(50);
    expect(stripAnsi(out)).toContain("你好世界-service");
  });

  test("passes redaction markers through verbatim without re-redacting", () => {
    const doc: SummaryDocument = {
      title: "SETUP READINESS",
      sections: [
        {
          title: "steps",
          rows: [
            {
              label: "proxy",
              tone: "error",
              detail: "setup failed: connect to [redacted] failed",
            },
          ],
        },
      ],
    };
    const out = stripAnsi(formatSummary(doc, { columns: 70 }));
    expect(out).toContain("[redacted]");
  });

  test("defaults to a readable width when columns is undefined", () => {
    const out = formatSummary(sampleDoc, {});
    const lines = linesOf(out);
    const width = displayWidth(lines[0] ?? "");
    expect(width).toBeGreaterThanOrEqual(40);
    for (const line of lines) expect(displayWidth(line)).toBe(width);
  });
});
