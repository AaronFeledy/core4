import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import {
  type SummaryDocument,
  formatQuietSummary,
  formatRailSummary,
  formatSummary,
} from "@lando/renderer/summary";

const chromaticSGR = new RegExp(
  `${String.fromCharCode(27)}\\[(?:\\d+;)*(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|38;[\\d;]+|48;[\\d;]+)(?:;\\d+)*m`,
  "u",
);
const doc: SummaryDocument = {
  title: "Report",
  tone: "warn",
  subtitle: "Host status",
  footer: "Finished",
  sections: [
    {
      title: "Services",
      rows: [
        {
          label: "web",
          tone: "ok",
          href: "https://web.test",
          fields: [{ label: "port", value: "3000" }],
          detail: "Ready",
          remedy: "Run `lando info`.",
        },
        { label: "worker", tone: "error" },
        { label: "cache", tone: "skipped", muted: true },
        { label: "queue", tone: "pending" },
        { label: "router", tone: "info" },
        { label: "db", tone: "warn" },
      ],
      notes: ["Review services"],
    },
  ],
  nextSteps: ["lando logs"],
};

for (const format of [formatSummary, formatQuietSummary, formatRailSummary]) {
  test(`${format.name} preserves text and layout when color is disabled`, () => {
    // Given
    const colored = format(doc, { columns: 32 });
    // When
    const monochrome = format(doc, { columns: 32, color: false });
    // Then
    expect(colored).toMatch(chromaticSGR);
    expect(monochrome).not.toMatch(chromaticSGR);
    expect(stripAnsi(monochrome)).toBe(stripAnsi(colored));
  });
  test(`${format.name} omits row hyperlinks when disabled`, () => {
    // Given
    const linked = format(doc);
    // When
    const plain = format(doc, { hyperlinks: false });
    // Then
    expect(linked).toContain("\x1b]8;");
    expect(plain).not.toContain("\x1b]8;");
    expect(stripAnsi(plain)).toBe(stripAnsi(linked));
  });
}
