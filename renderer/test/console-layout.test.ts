import { describe, expect, test } from "bun:test";

import {
  boxBody,
  boxBottom,
  boxSeparator,
  boxTop,
  displayWidth,
  fieldLabelWidth,
  hyperlink,
  resolveSummaryWidth,
  stripAnsi,
  toneChip,
  truncateToWidth,
  wrapFieldToWidth,
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

  test("counts emoji presentation characters as two columns", () => {
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("❌")).toBe(2);
    expect(displayWidth("✅ ready")).toBe(8);
  });

  test("counts a text-presentation symbol plus VS16 as one two-column glyph", () => {
    // U+26A0 WARNING SIGN + U+FE0F VARIATION SELECTOR-16
    expect(displayWidth("\u26a0\ufe0f")).toBe(2);
  });

  test("counts text-presentation check marks as one column", () => {
    expect(displayWidth("✔")).toBe(1);
    expect(displayWidth("✓")).toBe(1);
  });

  test("counts a multi-code-point emoji cluster as one two-column glyph", () => {
    expect(displayWidth("🇺🇸")).toBe(2); // regional indicator pair
    expect(displayWidth("👍🏽")).toBe(2); // skin-tone modifier
    expect(displayWidth("👨‍👩‍👧")).toBe(2); // ZWJ family sequence
  });

  test("counts CJK ideographs as two columns each", () => {
    expect(displayWidth("中文")).toBe(4);
  });

  test("ignores ANSI escape sequences", () => {
    expect(displayWidth(`${ESC}[32mok${ESC}[0m`)).toBe(2);
    expect(displayWidth(`${ESC}[32m中文${ESC}[0m`)).toBe(4);
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

  test("never splits a flag or ZWJ sequence when the cut lands inside the cluster", () => {
    // Given clusters of several code points; when only part of one fits the budget,
    // then the whole cluster is dropped rather than cut into stray code points.
    expect(truncateToWidth("🇺🇸🇫🇷", 3)).toBe("🇺🇸…");
    expect(truncateToWidth("ab👨‍👩‍👧cd", 5)).toBe("ab👨‍👩‍👧…");
    expect(truncateToWidth("ab👨‍👩‍👧cd", 4)).toBe("ab…");
    expect(truncateToWidth("ab👍🏽cd", 5)).toBe("ab👍🏽…");
    expect(truncateToWidth("e\u0301e\u0301e\u0301", 2)).toBe("e\u0301…");
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

  test("hard-breaks between grapheme clusters, never inside a flag or ZWJ sequence", () => {
    const family = "👨‍👩‍👧";
    const rows = wrapToWidth(`${family}🇺🇸👍🏽${family}🇫🇷`, 3);
    expect(rows).toEqual([family, "🇺🇸", "👍🏽", family, "🇫🇷"]);
    for (const row of rows) expect(displayWidth(row)).toBe(2);
    expect(wrapToWidth("x🇺🇸y", 2)).toEqual(["x", "🇺🇸", "y"]);
  });
});

test("wrapFieldToWidth moves a fitting path or URL below its separator", () => {
  const path = "/home/u/.local/share/lando/providers/provider-lando";
  const url = "http://appserver.myapp.internal:8080";
  expect(wrapFieldToWidth("target", path, 6, 54)).toEqual(["target :", path]);
  expect(wrapFieldToWidth("internal", url, 8, 44)).toEqual(["internal :", url]);
  expect(displayWidth(path)).toBeLessThanOrEqual(54);
  expect(displayWidth(url)).toBeLessThanOrEqual(44);
});

test("wrapFieldToWidth preserves spaces in a wrapped Windows path", () => {
  const value = "C:\\Program Files\\Lando\\logs\\my app server.log";
  const lines = wrapFieldToWidth("logFile", value, 7, 18);
  const prefixWidth = lines[0]?.indexOf(" : ") ?? -1;
  expect(prefixWidth).toBe(7);
  const valueStart = prefixWidth + 3;
  const reconstructed = [
    lines[0]?.slice(valueStart) ?? "",
    ...lines.slice(1).map((line) => line.slice(valueStart)),
  ].join("");
  expect(reconstructed).toBe(value);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.every((line) => displayWidth(line) <= 18)).toBe(true);
});

test("wrapFieldToWidth prefers spaces for log details and endpoint lists at 80 columns", () => {
  const logDetails = "probe: GET http://127.0.0.1:8000/health returned 302; strategy: redirect after startup";
  const endpoints = "http://127.0.0.1:49152/windows-cms http://127.0.0.1:49153/windows-cms";
  for (const value of [logDetails, endpoints]) {
    const lines = wrapFieldToWidth("logDetails", value, 12, 74);
    const valueStart = 15;
    const chunks = [
      lines[0]?.slice(valueStart) ?? "",
      ...lines.slice(1).map((line) => line.slice(valueStart)),
    ];
    expect(chunks.join("")).toBe(value);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith(" "))).toBe(true);
    expect(lines.every((line) => displayWidth(line) <= 74)).toBe(true);
  }
});

test("wrapFieldToWidth stacks a label wider than the label column over its full-width value", () => {
  // Given an 18-column field whose shared label column is 4 wide, when a label is wider than
  // that column, then it stays whole on its own `label :` line and the value wraps beneath it.
  expect(
    wrapFieldToWidth("rootPassword", "C:\\Program Files\\Lando\\logs\\my app server.log", 4, 18),
  ).toEqual(["rootPassword :", "C:\\Program ", "Files\\Lando\\logs\\m", "y app server.log"]);
  expect(wrapFieldToWidth("detail", "line one\nline two", 0, 12)).toEqual([
    "detail :",
    "line one",
    "line two",
  ]);
});

test("wrapFieldToWidth splits a stacked label only when it cannot fit beside its separator", () => {
  expect(wrapFieldToWidth("very-long-diagnostic-field-name", "y", 4, 18)).toEqual([
    "very-long-diagno",
    "stic-field-name :",
    "y",
  ]);
  expect(wrapFieldToWidth("sixteen-columns!", "y", 4, 18)).toEqual(["sixteen-columns! :", "y"]);
});

test("fieldLabelWidth keeps eight value columns and leaves wider labels to stack", () => {
  expect(fieldLabelWidth(["host", "rootPassword"], 74)).toBe(12);
  // 18 columns leave a 7-column cap: rootPassword stacks, host still aligns.
  expect(fieldLabelWidth(["host", "rootPassword"], 18)).toBe(4);
  expect(fieldLabelWidth(["host"], 8)).toBe(0);
  expect(fieldLabelWidth([], 40)).toBe(0);
});

test("resolveSummaryWidth reads unknown column counts as the default width", () => {
  expect(resolveSummaryWidth(120)).toBe(120);
  expect(resolveSummaryWidth(7)).toBe(10);
  for (const columns of [undefined, 0, -20, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(resolveSummaryWidth(columns)).toBe(80);
  }
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
