import { describe, expect, test } from "bun:test";

import {
  boxBody,
  boxBottom,
  boxSeparator,
  boxTop,
  displayWidth,
  hyperlink,
  stripAnsi,
  toneChip,
  truncateToWidth,
  wrapToWidth,
} from "@lando/renderer/console-layout";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ST = `${ESC}\\`;

describe("displayWidth", () => {
  test("counts ASCII as one column each", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  test("counts CJK/wide characters as two columns each", () => {
    expect(displayWidth("你好")).toBe(4);
    expect(displayWidth("こんにちは")).toBe(10);
    expect(displayWidth("한글")).toBe(4);
    // Fullwidth digits
    expect(displayWidth("１２３")).toBe(6);
  });

  test("ignores ANSI escape sequences", () => {
    expect(displayWidth(`${ESC}[32mok${ESC}[0m`)).toBe(2);
  });

  test("treats combining marks and variation selectors as zero width", () => {
    // base 'e' + combining acute accent
    expect(displayWidth("e\u0301")).toBe(1);
  });
});

describe("truncateToWidth", () => {
  test("returns text unchanged when it fits", () => {
    expect(truncateToWidth("short", 10)).toBe("short");
  });

  test("truncates ASCII with an ellipsis within the budget", () => {
    const out = truncateToWidth("abcdefghij", 5);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });

  test("does not split a wide char across the budget boundary", () => {
    const out = truncateToWidth("你好世界", 5);
    // 5 columns: two wide chars = 4 cols + ellipsis = 5 cols
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("wrapToWidth", () => {
  test("keeps a short line as one row", () => {
    expect(wrapToWidth("one two", 40)).toEqual(["one two"]);
  });

  test("wraps long content on word boundaries within width", () => {
    const rows = wrapToWidth("alpha beta gamma delta epsilon", 12);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(12);
    expect(rows.join(" ")).toBe("alpha beta gamma delta epsilon");
  });

  test("hard-breaks a single token longer than the width", () => {
    const rows = wrapToWidth("/very/long/unbreakable/path/segment", 10);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(10);
  });
});

describe("box helpers", () => {
  const W = 40;

  test("boxTop renders a left-anchored title capped to width", () => {
    const line = stripAnsi(boxTop("UNINSTALL PLAN", W));
    expect(line.startsWith("╭─ UNINSTALL PLAN ")).toBe(true);
    expect(displayWidth(line)).toBe(W);
    expect(line.endsWith("╮")).toBe(true);
  });

  test("boxBottom and boxSeparator match the width with their glyphs", () => {
    const bottom = stripAnsi(boxBottom("11 steps", W));
    expect(displayWidth(bottom)).toBe(W);
    expect(bottom.endsWith("╯")).toBe(true);
    const sep = stripAnsi(boxSeparator("next steps", W));
    expect(displayWidth(sep)).toBe(W);
    expect(sep.startsWith("├─ next steps ")).toBe(true);
    expect(sep.endsWith("┤")).toBe(true);
  });

  test("boxBody pads to width with side borders and preserves wide-char alignment", () => {
    const body = stripAnsi(boxBody("你好 service", W));
    expect(displayWidth(body)).toBe(W);
    expect(body.startsWith("│ ")).toBe(true);
    expect(body.endsWith(" │")).toBe(true);
  });

  test("boxBody truncates content that exceeds the inner width", () => {
    const body = stripAnsi(boxBody("x".repeat(100), W));
    expect(displayWidth(body)).toBe(W);
    expect(body).toContain("…");
  });
});

describe("toneChip", () => {
  test("produces a bracketed text chip per tone", () => {
    expect(stripAnsi(toneChip("ok"))).toBe("[OK]");
    expect(stripAnsi(toneChip("warn"))).toBe("[WARN]");
    expect(stripAnsi(toneChip("error"))).toBe("[FAIL]");
    expect(stripAnsi(toneChip("info"))).toBe("[INFO]");
    expect(stripAnsi(toneChip("pending"))).toBe("[WAIT]");
    expect(stripAnsi(toneChip("skipped"))).toBe("[SKIP]");
  });

  test("status is never color-only: the chip carries readable text", () => {
    const chip = toneChip("error");
    expect(stripAnsi(chip)).toBe("[FAIL]");
  });
});

describe("stripAnsi OSC 8", () => {
  test("removes OSC 8 sequences terminated by ST and preserves visible text", () => {
    // Given a hyperlink wrapped with OSC 8 ST terminators.
    const linked = `${ESC}]8;;https://example.com${ST}visible${ESC}]8;;${ST}`;

    // When ANSI is stripped, then only the visible label remains and width matches it.
    expect(stripAnsi(linked)).toBe("visible");
    expect(displayWidth(linked)).toBe(displayWidth("visible"));
  });

  test("removes OSC 8 sequences terminated by BEL and preserves visible text", () => {
    // Given a hyperlink wrapped with OSC 8 BEL terminators.
    const linked = `${ESC}]8;;https://example.com${BEL}visible${ESC}]8;;${BEL}`;

    // When ANSI is stripped, then only the visible label remains and width matches it.
    expect(stripAnsi(linked)).toBe("visible");
    expect(displayWidth(linked)).toBe(displayWidth("visible"));
  });

  test("still strips CSI/SGR around OSC 8", () => {
    // Given dim SGR wrapping an OSC 8 ST hyperlink.
    const mixed = `${ESC}[2m${ESC}]8;;https://example.com${ST}visible${ESC}]8;;${ST}${ESC}[22m`;

    // When ANSI is stripped, then CSI and OSC are both gone.
    expect(stripAnsi(mixed)).toBe("visible");
    expect(displayWidth(mixed)).toBe(7);
  });
});

describe("hyperlink", () => {
  test("wraps a safe https target in OSC 8 with ST terminators", () => {
    // Given visible text and a safe https href.
    // When hyperlink is applied, then OSC 8 ST wraps the visible text.
    expect(hyperlink("docs", "https://example.com/docs")).toBe(
      `${ESC}]8;;https://example.com/docs${ST}docs${ESC}]8;;${ST}`,
    );
  });

  test("wraps a safe http target in OSC 8 with ST terminators", () => {
    expect(hyperlink("local", "http://localhost:3000")).toBe(
      `${ESC}]8;;http://localhost:3000${ST}local${ESC}]8;;${ST}`,
    );
  });

  test("returns visible text unchanged for an empty target", () => {
    expect(hyperlink("docs", "")).toBe("docs");
  });

  test("returns visible text unchanged for a non-http target", () => {
    expect(hyperlink("db", "tcp://localhost:5432")).toBe("db");
    expect(hyperlink("file", "file:///tmp/x")).toBe("file");
  });

  test("returns visible text unchanged when the target contains C0, DEL, or ESC", () => {
    expect(hyperlink("x", `https://example.com/${ESC}[31m`)).toBe("x");
    expect(hyperlink("x", `https://example.com/${BEL}`)).toBe("x");
    expect(hyperlink("x", "https://example.com/\u0000")).toBe("x");
    expect(hyperlink("x", "https://example.com/\u007f")).toBe("x");
  });
});
