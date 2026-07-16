import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "../../src/cli/renderer/console-layout.ts";
import { type SummaryDocument, formatSummary } from "../../src/cli/renderer/summary.ts";

const ESC = String.fromCharCode(27);
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const DIM_RESET = `${ESC}[22m`;
const GREEN = `${ESC}[32m`;
const PINK = `${ESC}[95m`;
const RESET = `${ESC}[0m`;

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

  test("renders frame titles and borders bright pink", () => {
    // Given a grouped summary with titled frame lines.
    const lines = linesOf(formatSummary(sampleDoc, { columns: 80 }));
    const separator = lines.find((line) => stripAnsi(line).startsWith("├─ toolchain"));

    // When the frame is styled, then its title-bearing lines use bright pink.
    expect(lines[0]?.startsWith(`${BOLD}${PINK}╭─ UNINSTALL PLAN`)).toBe(true);
    expect(separator?.startsWith(`${PINK}├─ toolchain`)).toBe(true);
  });

  test("keeps body borders pink when row content has a tone", () => {
    // Given a summary row whose content is painted with a status tone.
    const bodyLines = linesOf(formatSummary(sampleDoc, { columns: 80 })).filter((line) =>
      stripAnsi(line).includes("[OK]"),
    );

    // When the row is framed, then both vertical borders retain the frame color.
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines[0]?.startsWith(`${PINK}│${RESET} ${GREEN}`)).toBe(true);
    expect(bodyLines[0]?.endsWith(` ${PINK}│${RESET}`)).toBe(true);
  });

  test("keeps the bottom frame pink when footer text is dimmed", () => {
    // Given a grouped summary whose bottom frame contains footer text.
    const lines = linesOf(formatSummary(sampleDoc, { columns: 80 }));
    const footer = lines[lines.length - 1];

    // When the footer is styled, then its text style is isolated from both frame segments.
    expect(footer?.startsWith(`${PINK}╰─${RESET}${DIM}${PINK} `)).toBe(true);
    expect(footer).toContain(`${DIM_RESET}${RESET}${PINK}─`);
    expect(footer?.endsWith(`╯${RESET}`)).toBe(true);
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
