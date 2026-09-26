import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import { type SummaryDocument, formatRailSummary } from "@lando/renderer/summary";

const ESC = String.fromCharCode(27);
const PINK = `${ESC}[95m`;
const CYAN = `${ESC}[36m`;
const AMBER = `${ESC}[33m`;

const doc: SummaryDocument = {
  title: "Needs attention",
  tone: "warn",
  subtitle: "Lando 4.0.0 · provider lando (managed)",
  sections: [
    {
      title: "provider",
      rows: [
        {
          label: "preferred-host-ports",
          tone: "warn",
          fields: [
            { label: "host", value: "127.0.0.1" },
            { label: "ports", value: "80,443" },
          ],
          remedy: "Stop the process holding the port. Run `lando restart`.",
        },
        { label: "host-proxy-transport", tone: "error", value: "3×" },
      ],
    },
    { title: "mcp", rows: [{ label: "mcp", tone: "ok", value: "pass" }] },
  ],
  nextSteps: ["lando restart"],
  footer: "4 checks · 1 failed · 1 warning",
};

describe("formatRailSummary", () => {
  test("frames the report in the task-tree rail with single-cell glyphs", () => {
    expect(stripAnsi(formatRailSummary(doc, { columns: 80 }))).toBe(
      [
        "╭─ Needs attention",
        "│ Lando 4.0.0 · provider lando (managed)",
        "│",
        "│ provider",
        "│ ! preferred-host-ports",
        "│   host: 127.0.0.1 · ports: 80,443",
        "│   ↳ Stop the process holding the port. Run `lando restart`.",
        "│",
        "│ ✗ host-proxy-transport  3×",
        "│",
        "│ mcp",
        "│ ✓ mcp  pass",
        "│",
        "├─ next",
        "│ lando restart",
        "╰─ 4 checks · 1 failed · 1 warning",
      ].join("\n"),
    );
  });

  test("paints the rail pink, the warn row amber, and commands cyan", () => {
    const out = formatRailSummary(doc, { columns: 80 });
    expect(out.startsWith(`${PINK}╭─`)).toBe(true);
    expect(out).toContain(`${AMBER}! preferred-host-ports`);
    expect(out).toContain(`${CYAN}\`lando restart\``);
    expect(out).toContain(`${CYAN}lando restart`);
  });

  test("keeps field pairs whole and hangs the remedy when wrapping", () => {
    const lines = stripAnsi(formatRailSummary(doc, { columns: 30 })).split("\n");
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
    expect(lines).toContain("│   host: 127.0.0.1");
    expect(lines).toContain("│   ports: 80,443");
    expect(lines.some((line) => line.startsWith("│   · "))).toBe(false);
    const arrow = lines.findIndex((line) => line.startsWith("│   ↳ "));
    expect(lines[arrow + 1]?.startsWith("│     ")).toBe(true);
  });

  test("keeps a code span painted across a wrap", () => {
    const out = formatRailSummary(
      {
        title: "t",
        sections: [{ title: "s", rows: [{ label: "r", remedy: "Run `lando doctor --fix --app` now." }] }],
      },
      { columns: 26 },
    );
    const lines = out.split("\n");
    const continuation = lines.find((line) => stripAnsi(line).includes("--app`"));
    expect(continuation).toContain(CYAN);
  });

  test("collapses a report with no sections to title, subtitle, and footer", () => {
    expect(
      stripAnsi(
        formatRailSummary({
          title: "Healthy",
          tone: "ok",
          subtitle: "Lando 4",
          sections: [],
          footer: "9 checks passed",
        }),
      ),
    ).toBe(["╭─ Healthy", "│ Lando 4", "╰─ 9 checks passed"].join("\n"));
  });

  test("redacts before paint", () => {
    const out = formatRailSummary(doc, { redact: (text) => text.replaceAll("127.0.0.1", "[redacted]") });
    expect(stripAnsi(out)).toContain("host: [redacted]");
  });
});
