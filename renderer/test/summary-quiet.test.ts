import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import { type SummaryDocument, formatQuietSummary, redactSummaryDocument } from "@lando/renderer/summary";

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const DIM_RESET = `${ESC}[22m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const PINK = `${ESC}[95m`;
const RESET = `${ESC}[0m`;
const ST = `${ESC}\\`;

const linesOf = (text: string): ReadonlyArray<string> => text.split("\n");

const readyDoc: SummaryDocument = {
  title: "Started",
  tone: "ok",
  subtitle: "my-app is ready",
  sections: [
    {
      title: "URLs",
      rows: [
        { label: "https://my-app.lndo.site", href: "https://my-app.lndo.site" },
        { label: "http://localhost:3000", href: "http://localhost:3000" },
      ],
    },
    {
      title: "Services",
      rows: [
        { label: "web", tone: "ok", value: "running" },
        { label: "database", tone: "ok", value: "ready" },
      ],
    },
  ],
  nextSteps: ["lando info", "lando logs", "lando exec -- <cmd>"],
  footer: "2 services ready",
};

const mixedDoc: SummaryDocument = {
  title: "Not fully ready",
  tone: "error",
  subtitle: "my-app is not fully ready",
  sections: [
    {
      title: "URLs",
      rows: [{ label: "http://localhost:3000", href: "http://localhost:3000" }],
    },
    {
      title: "Services",
      rows: [
        { label: "web", tone: "ok", value: "running" },
        { label: "database", tone: "skipped", value: "stopped" },
        { label: "worker", tone: "error", value: "failed" },
      ],
    },
  ],
  nextSteps: ["lando info", "lando logs"],
  footer: "1 of 3 services ready",
};

describe("formatQuietSummary layout", () => {
  test("omits box glyphs, frame padding, and pink chrome", () => {
    // Given a ready summary document.
    const out = formatQuietSummary(readyDoc, { columns: 80 });
    const visible = stripAnsi(out);

    // When formatted quietly, then there is no frame, no padding to width, and no pink.
    expect(visible).not.toMatch(/[╭╮╰╯├┤│─]/u);
    expect(out).not.toContain(PINK);
    expect(displayWidth(linesOf(out)[0] ?? "")).toBeLessThan(80);
    expect(displayWidth(linesOf(out)[0] ?? "")).toBe(displayWidth("Started"));
  });

  test("renders title plain and dims subtitle, section headings, and footer", () => {
    // Given a ready summary document.
    const lines = linesOf(formatQuietSummary(readyDoc, { columns: 80 }));

    // When painted, then only subtitle/headings/footer use dim, and the title stays unstyled.
    expect(lines[0]).toBe("Started");
    expect(lines[1]).toBe(`  ${DIM}my-app is ready${DIM_RESET}${RESET}`);
    expect(lines.find((line) => stripAnsi(line) === "URLs")).toBe(`${DIM}URLs${DIM_RESET}${RESET}`);
    expect(lines.find((line) => stripAnsi(line) === "Services")).toBe(`${DIM}Services${DIM_RESET}${RESET}`);
    expect(lines.find((line) => stripAnsi(line) === "Next")).toBe(`${DIM}Next${DIM_RESET}${RESET}`);
    expect(lines[lines.length - 1]).toBe(`${DIM}2 services ready${DIM_RESET}${RESET}`);
  });

  test("indents body rows two spaces and separates groups with blank lines", () => {
    // Given a ready summary document.
    const visible = stripAnsi(formatQuietSummary(readyDoc, { columns: 80 }));

    // When laid out, then groups are whitespace-separated and body rows are indented.
    expect(visible).toBe(
      [
        "Started",
        "  my-app is ready",
        "",
        "URLs",
        "  https://my-app.lndo.site",
        "  http://localhost:3000",
        "",
        "Services",
        "  web  running",
        "  database  ready",
        "",
        "Next",
        "  lando info",
        "  lando logs",
        "  lando exec -- <cmd>",
        "",
        "2 services ready",
      ].join("\n"),
    );
  });

  test("wraps so visible width never exceeds columns", () => {
    // Given a long unbreakable URL on a narrow terminal.
    const href = "https://example.com/very/long/path/that/must/wrap";
    const doc: SummaryDocument = {
      title: "Started",
      sections: [{ title: "URLs", rows: [{ label: href, href }] }],
    };

    // When wrapped at 36 columns, then no visible line exceeds that width.
    const out = formatQuietSummary(doc, { columns: 36 });
    for (const line of linesOf(out)) expect(displayWidth(line)).toBeLessThanOrEqual(36);
    expect(stripAnsi(out)).toContain("example.com");
  });
});

describe("formatQuietSummary row style", () => {
  test("omits chip and paint on ok rows", () => {
    // Given service rows whose tone is ok.
    const out = formatQuietSummary(readyDoc, { columns: 80 });
    const web = linesOf(out).find((line) => stripAnsi(line).includes("web  running"));

    // When painted, then success is typography-only: no chip and no tone color.
    expect(web).toBe("  web  running");
    expect(out).not.toContain("[OK]");
    expect(out).not.toContain(GREEN);
  });

  test("applies toneChip and paintTone only to non-ok rows", () => {
    // Given mixed service rows including skipped and failed.
    const lines = linesOf(formatQuietSummary(mixedDoc, { columns: 80 }));
    const web = lines.find((line) => stripAnsi(line).includes("web  running"));
    const skipped = lines.find((line) => stripAnsi(line).includes("database  stopped"));
    const failed = lines.find((line) => stripAnsi(line).includes("worker  failed"));

    // When painted, then only non-ok rows get a chip and tone paint.
    expect(web).toBe("  web  running");
    expect(stripAnsi(skipped ?? "")).toBe("  [SKIP] database  stopped");
    expect(skipped).toContain(DIM);
    expect(stripAnsi(failed ?? "")).toBe("  [FAIL] worker  failed");
    expect(failed).toContain(RED);
    expect(failed).toContain("[FAIL]");
  });

  test("dims a muted body row", () => {
    // Given a body row marked muted with no tone.
    const doc: SummaryDocument = {
      title: "Started",
      sections: [{ title: "URLs", rows: [{ label: "http://example.com", muted: true }] }],
    };

    // When painted, then the row body uses dim SGR.
    const body = linesOf(formatQuietSummary(doc, { columns: 80 })).find((line) =>
      stripAnsi(line).includes("http://example.com"),
    );
    expect(body).toBe(`  ${DIM}http://example.com${DIM_RESET}${RESET}`);
  });

  test("emits a complete OSC 8 link on each wrapped segment", () => {
    // Given a long https row whose label must wrap at 36 columns.
    const href = "https://example.com/very/long/path/that/must/wrap";
    const doc: SummaryDocument = {
      title: "Started",
      sections: [{ title: "URLs", rows: [{ label: href, href }] }],
    };

    // When wrapped, then every visible URL segment is a closed OSC 8 link.
    const out = formatQuietSummary(doc, { columns: 36 });
    const body = linesOf(out).filter((line) =>
      /example\.com|\/very\/|\/path\/|\/must\/|\/wrap/.test(stripAnsi(line)),
    );
    expect(body.length).toBeGreaterThan(1);
    for (const line of body) {
      expect(line).toContain(`${ESC}]8;;${href}${ST}`);
      expect(line.includes(`${ESC}]8;;${ST}`)).toBe(true);
      expect(displayWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  test("omits OSC 8 when href is unsafe", () => {
    // Given a row whose href is a non-http target.
    const doc: SummaryDocument = {
      title: "Started",
      sections: [{ title: "URLs", rows: [{ label: "tcp://localhost:5432", href: "tcp://localhost:5432" }] }],
    };

    // When painted, then the label stays visible and unlinked.
    const out = formatQuietSummary(doc, { columns: 80 });
    expect(out).not.toContain(`${ESC}]8;`);
    expect(stripAnsi(out)).toContain("tcp://localhost:5432");
  });

  test("redacts document fields before painting so SGR stays complete", () => {
    // Given a linked muted row whose href carries a secret host fragment.
    const doc: SummaryDocument = {
      title: "Started",
      sections: [
        {
          title: "URLs",
          rows: [
            {
              label: "https://secret.example/token",
              href: "https://secret.example/token",
              muted: true,
            },
          ],
        },
      ],
    };
    const redact = (text: string) => text.split("secret").join("[redacted]");

    // When redacted then painted, the secret does not leak and muted/href survive.
    const redacted = redactSummaryDocument(doc, redact).sections[0]?.rows[0];
    expect(redacted?.href).toBe("https://[redacted].example/token");
    expect(redacted?.muted).toBe(true);
    const painted = formatQuietSummary(doc, { columns: 80, redact });
    expect(painted).toContain("[redacted]");
    expect(painted).not.toContain("secret");
    expect(painted).toContain(`${ESC}]8;;https://[redacted].example/token${ST}`);
    expect(painted).toContain(DIM);
  });
});
