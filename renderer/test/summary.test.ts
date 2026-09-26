import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import {
  type SummaryDocument,
  formatQuietSummary,
  formatRailSummary,
  formatSummary,
  redactSummaryDocument,
} from "@lando/renderer/summary";

const ESC = String.fromCharCode(27);
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const DIM_RESET = `${ESC}[22m`;
const GREEN = `${ESC}[32m`;
const PINK = `${ESC}[95m`;
const RESET = `${ESC}[0m`;
const ST = `${ESC}\\`;

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
          fields: [{ label: "target", value: "/home/u/.local/share/lando/providers/provider-lando" }],
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

  test("redacts document fields before painting so SGR stays complete", () => {
    const doc: SummaryDocument = {
      title: "SETUP",
      tone: "ok",
      sections: [
        {
          title: "runtime",
          rows: [{ label: "token", tone: "ok", value: "hunter2-secret" }],
        },
      ],
    };
    const redact = (text: string) => text.split("hunter2-secret").join("[redacted]");
    expect(redactSummaryDocument(doc, redact).sections[0]?.rows[0]?.value).toBe("[redacted]");
    const painted = formatSummary(doc, { columns: 80, redact });
    expect(painted).toContain(GREEN);
    expect(painted).toContain("[redacted]");
    expect(painted).not.toContain("hunter2-secret");
    expect(painted.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "")).not.toContain("]m");
    for (const line of linesOf(painted)) expect(displayWidth(line)).toBe(80);
  });
});

describe("formatSummary row href and muted", () => {
  test("emits a complete OSC 8 link on each wrapped segment after wrapping", () => {
    // Given a long https row whose label must wrap at 36 columns.
    const href = "https://example.com/very/long/path/that/must/wrap";
    const doc: SummaryDocument = {
      title: "START",
      sections: [{ title: "urls", rows: [{ label: href, href }] }],
    };

    // When the summary is framed, then every wrapped body segment is a closed OSC 8 link.
    const out = formatSummary(doc, { columns: 36 });
    const lines = linesOf(out);
    for (const line of lines) expect(displayWidth(line)).toBe(36);
    const body = lines.filter((line) =>
      /example\.com|\/very\/|\/path\/|\/must\/|\/wrap/.test(stripAnsi(line)),
    );
    expect(body.length).toBeGreaterThan(1);
    for (const line of body) {
      expect(line).toContain(`${ESC}]8;;${href}${ST}`);
      expect(line.includes(`${ESC}]8;;${ST}`)).toBe(true);
    }
  });

  test("dims a muted body row", () => {
    // Given a body row marked muted with no tone.
    const doc: SummaryDocument = {
      title: "START",
      sections: [{ title: "urls", rows: [{ label: "http://example.com", muted: true }] }],
    };

    // When the summary is painted, then the row body uses dim SGR.
    const body = linesOf(formatSummary(doc, { columns: 80 })).find((line) =>
      stripAnsi(line).includes("http://example.com"),
    );
    expect(body).toContain(`${DIM}http://example.com${DIM_RESET}`);
  });

  test("omits OSC 8 when href is unsafe", () => {
    // Given a row whose href is a non-http target.
    const doc: SummaryDocument = {
      title: "START",
      sections: [{ title: "urls", rows: [{ label: "tcp://localhost:5432", href: "tcp://localhost:5432" }] }],
    };

    // When the summary is painted, then the label stays visible and unlinked.
    const out = formatSummary(doc, { columns: 80 });
    expect(out).not.toContain(`${ESC}]8;`);
    expect(stripAnsi(out)).toContain("tcp://localhost:5432");
  });

  test("redacts href and preserves muted", () => {
    // Given a linked muted row whose href carries a secret host fragment.
    const doc: SummaryDocument = {
      title: "START",
      sections: [
        {
          title: "urls",
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

    // When the document is redacted, then href is masked and muted is kept.
    const redacted = redactSummaryDocument(doc, redact).sections[0]?.rows[0];
    expect(redacted?.href).toBe("https://[redacted].example/token");
    expect(redacted?.muted).toBe(true);

    // When the summary is painted with that redactor, then the secret does not leak.
    const painted = formatSummary(doc, { columns: 80, redact });
    expect(painted).toContain("[redacted]");
    expect(painted).not.toContain("secret");
    expect(painted).toContain(`${ESC}]8;;https://[redacted].example/token${ST}`);
    expect(painted).toContain(DIM);
  });

  test("composes tone paint with a safe href", () => {
    // Given a toned row that is also a safe https link.
    const doc: SummaryDocument = {
      title: "START",
      sections: [
        {
          title: "urls",
          rows: [{ label: "https://example.com", tone: "ok", href: "https://example.com" }],
        },
      ],
    };

    // When the row is painted, then tone SGR and OSC 8 both wrap the visible label.
    const body = linesOf(formatSummary(doc, { columns: 80 })).find((line) =>
      stripAnsi(line).includes("https://example.com"),
    );
    expect(body).toContain(GREEN);
    expect(body).toContain(`${ESC}]8;;https://example.com${ST}`);
  });
});

describe("formatSummary remedy", () => {
  test("frames a remedy as a hanging arrow line inside the box", () => {
    const out = stripAnsi(
      formatSummary(
        {
          title: "DOCTOR",
          sections: [
            {
              title: "provider",
              rows: [
                { label: "ports", tone: "warn", remedy: "Stop the process holding the port and retry." },
              ],
            },
          ],
        },
        { columns: 40 },
      ),
    );
    const lines = out.split("\n");
    expect(lines).toContain("│   ↳ Stop the process holding the     │");
    expect(lines).toContain("│     port and retry.                  │");
    for (const line of lines) expect(displayWidth(line)).toBe(40);
  });
});

test("aligns field separators across rows in both summary layouts", () => {
  const doc: SummaryDocument = {
    title: "APP INFO",
    sections: [
      {
        title: "services",
        rows: [
          { label: "appserver", fields: [{ label: "endpoints", value: "https://example.test" }] },
          { label: "database", fields: [{ label: "rootPassword", value: "[redacted]" }] },
        ],
      },
    ],
  };
  for (const render of [formatSummary, formatQuietSummary]) {
    const lines = stripAnsi(render(doc, { columns: 100 })).split("\n");
    const fields = lines.filter((line) => line.includes("endpoints") || line.includes("rootPassword"));
    expect(fields).toHaveLength(2);
    expect(fields[0]?.indexOf(" : ")).toBe(fields[1]?.indexOf(" : "));
  }
});

test("aligns separators and retains long field values when they wrap", () => {
  const url = "http://127.0.0.1:49281/very/long/appserver/debug/endpoint";
  const logFile = "C:\\Program Files\\Lando\\logs\\my app server.log";
  const doc: SummaryDocument = {
    title: "APP INFO",
    sections: [
      {
        title: "services",
        rows: [
          { label: "appserver", fields: [{ label: "url", value: url }] },
          { label: "database", fields: [{ label: "rootPassword", value: logFile }] },
        ],
      },
    ],
  };

  for (const columns of [44, 24]) {
    for (const render of [formatSummary, formatQuietSummary]) {
      const visible = stripAnsi(render(doc, { columns }));
      const lines = visible.split("\n");
      const separators = lines.filter((line) => line.includes(" : "));
      expect(separators).toHaveLength(2);
      expect(separators[0]?.indexOf(" : ")).toBe(separators[1]?.indexOf(" : "));
      expect(lines.every((line) => displayWidth(line) <= columns)).toBe(true);
      const compact = visible.replace(/[│\s]/gu, "");
      expect(compact).toContain(url);
    }
  }
});

test("keeps words together in 80-column log details and endpoint lists", () => {
  const doc: SummaryDocument = {
    title: "APP INFO",
    sections: [
      {
        title: "services",
        rows: [
          {
            label: "appserver",
            fields: [
              {
                label: "endpoints",
                value: "http://127.0.0.1:49152/windows-cms http://127.0.0.1:49153/windows-cms",
              },
            ],
          },
          {
            label: "database",
            fields: [
              {
                label: "logDetails",
                value:
                  "probe: GET http://127.0.0.1:8000/health returned 302; strategy: redirect after startup",
              },
            ],
          },
        ],
      },
    ],
  };

  for (const render of [formatSummary, formatQuietSummary]) {
    const lines = stripAnsi(render(doc, { columns: 80 })).split("\n");
    const separators = lines.filter((line) => line.includes(" : "));
    expect(separators).toHaveLength(2);
    expect(separators[0]?.indexOf(" : ")).toBe(separators[1]?.indexOf(" : "));
    expect(lines.filter((line) => line.includes("windows-cms"))).toHaveLength(2);
    expect(lines.some((line) => line.includes("redirect"))).toBe(true);
    expect(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
  }
});

test("keeps short field values beside their labels at narrow terminal widths", () => {
  const doc: SummaryDocument = {
    title: "APP INFO",
    sections: [
      {
        title: "services",
        rows: [
          { label: "appserver", fields: [{ label: "host", value: "x" }] },
          { label: "database", fields: [{ label: "very-long-diagnostic-field-name", value: "y" }] },
        ],
      },
    ],
  };
  const boxed = stripAnsi(formatSummary(doc, { columns: 24 }));
  const quiet = stripAnsi(formatQuietSummary(doc, { columns: 24 }));
  expect(boxed.split("\n").some((line) => /host\s+: x/u.test(line))).toBe(true);
  expect(quiet.split("\n").some((line) => /host\s+: x/u.test(line))).toBe(true);
  expect(boxed.split("\n").some((line) => /^│\s+│$/u.test(line))).toBe(false);
  expect(quiet.split("\n").some((line) => line.length > 0 && line.trim().length === 0)).toBe(false);
});

test("summary formats honor terminal widths below 24 columns", () => {
  const doc: SummaryDocument = {
    title: "APP INFO",
    sections: [
      {
        title: "services",
        rows: [{ label: "appserver", fields: [{ label: "host", value: "localhost" }] }],
      },
    ],
  };
  const width = 10;
  for (const output of [
    formatSummary(doc, { columns: width }),
    formatQuietSummary(doc, { columns: width }),
    formatRailSummary(doc, { columns: width }),
  ]) {
    expect(
      stripAnsi(output)
        .split("\n")
        .every((line) => displayWidth(line) <= width),
    ).toBe(true);
  }
});

test("keeps multiline field values inside the frame", () => {
  const doc: SummaryDocument = {
    title: "DOCTOR",
    sections: [
      {
        title: "provider",
        rows: [
          {
            label: "runtime",
            fields: [{ label: "detail", value: "podman machine failed to start cleanly\nERROR: disk full" }],
          },
        ],
      },
    ],
  };
  for (const render of [formatSummary, formatQuietSummary]) {
    const lines = stripAnsi(render(doc, { columns: 32 })).split("\n");
    expect(lines.every((line) => !line.includes("\r") && displayWidth(line) <= 32)).toBe(true);
    expect(lines.some((line) => line.includes("ERROR: disk full"))).toBe(true);
  }
  const boxed = stripAnsi(formatSummary(doc, { columns: 32 })).split("\n");
  const errorLine = boxed.find((line) => line.includes("ERROR: disk full")) ?? "";
  expect(errorLine.startsWith("│")).toBe(true);
  expect(displayWidth(errorLine)).toBe(32);
});
