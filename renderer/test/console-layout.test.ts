import { describe, expect, test } from "bun:test";

import {
  boxBody,
  boxBottom,
  boxSeparator,
  boxTop,
  dimText,
  displayWidth,
  fieldLabelWidth,
  hyperlink,
  linkKnownHttpUrls,
  resolveSummaryWidth,
  shouldEmitHyperlinks,
  stripAnsi,
  styleBoxBottom,
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

test("truncateToWidth reads line breaks on single-line surfaces as spaces", () => {
  expect(truncateToWidth("APP\nINFO", 20)).toBe("APP INFO");
  expect(truncateToWidth("one\r\ntwo three", 8)).toBe("one two…");
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

  test("starts a new row at every embedded line break and drops blank rows", () => {
    expect(wrapToWidth("one\ntwo", 40)).toEqual(["one", "two"]);
    expect(wrapToWidth("a\r\nb\rc", 40)).toEqual(["a", "b", "c"]);
    expect(wrapToWidth("a\n\n  \nb", 40)).toEqual(["a", "b"]);
    expect(wrapToWidth("\n", 40)).toEqual([""]);
    expect(wrapToWidth("alpha beta\ngamma", 6)).toEqual(["alpha", "beta", "gamma"]);
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

  test("wraps a safe file target in OSC 8 with ST terminators", () => {
    expect(hyperlink("/tmp/app", "file:///tmp/app")).toBe(
      `${ESC}]8;;file:///tmp/app${ST}/tmp/app${ESC}]8;;${ST}`,
    );
  });

  test("returns visible text unchanged for a non-http non-file target", () => {
    expect(hyperlink("db", "tcp://localhost:5432")).toBe("db");
    expect(hyperlink("ide", "vscode://file/tmp/x")).toBe("ide");
    expect(hyperlink("script", "javascript:alert(1)")).toBe("script");
    expect(hyperlink("payload", "data:text/plain,hi")).toBe("payload");
    expect(hyperlink("rel", "/tmp/app")).toBe("rel");
    expect(hyperlink("rel", "./readme")).toBe("rel");
  });

  test("keeps an SGR-styled label linked as the summary painters hand it over", () => {
    const dimmed = dimText("https://example.com/docs");
    expect(hyperlink(dimmed, "https://example.com/docs")).toBe(
      `${ESC}]8;;https://example.com/docs${ST}${dimmed}${ESC}]8;;${ST}`,
    );
  });

  test("returns visible text unchanged when the target contains C0, DEL, or ESC", () => {
    expect(hyperlink("x", `https://example.com/${ESC}[31m`)).toBe("x");
    expect(hyperlink("x", `https://example.com/${BEL}`)).toBe("x");
    expect(hyperlink("x", "https://example.com/\u0000")).toBe("x");
    expect(hyperlink("x", "https://example.com/\u007f")).toBe("x");
    expect(hyperlink("x", `file:///tmp/${ESC}x`)).toBe("x");
  });
});

describe("shouldEmitHyperlinks", () => {
  test("emits on a TTY when TERM is set and NO_COLOR is unset", () => {
    expect(shouldEmitHyperlinks({ isTTY: true, env: { TERM: "xterm-256color" } })).toBe(true);
  });

  test("treats empty NO_COLOR as unset", () => {
    expect(shouldEmitHyperlinks({ isTTY: true, env: { TERM: "xterm-256color", NO_COLOR: "" } })).toBe(true);
  });

  test("stays plain when stdout is not a TTY", () => {
    expect(shouldEmitHyperlinks({ isTTY: false, env: { TERM: "xterm-256color" } })).toBe(false);
  });

  test("stays plain when NO_COLOR is set", () => {
    expect(shouldEmitHyperlinks({ isTTY: true, env: { TERM: "xterm-256color", NO_COLOR: "1" } })).toBe(false);
  });

  test("stays plain when TERM is dumb", () => {
    expect(shouldEmitHyperlinks({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
  });

  test("stays plain when env is missing", () => {
    expect(shouldEmitHyperlinks({ isTTY: true })).toBe(false);
  });
});

describe("linkKnownHttpUrls", () => {
  test("wraps each intact http(s) URL and leaves other text alone", () => {
    const text = "web\thttps://app.lndo.site, http://localhost:3000, tcp://localhost:5432";
    expect(
      linkKnownHttpUrls(text, ["https://app.lndo.site", "http://localhost:3000", "tcp://localhost:5432"]),
    ).toBe(
      `web\t${hyperlink("https://app.lndo.site", "https://app.lndo.site")}, ${hyperlink("http://localhost:3000", "http://localhost:3000")}, tcp://localhost:5432`,
    );
  });

  test("leaves a URL plain when wrapping split the label", () => {
    expect(linkKnownHttpUrls("https://example.com/very", ["https://example.com/very/long"])).toBe(
      "https://example.com/very",
    );
  });

  test("links a prefix pair as whole tokens with one OSC each", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080";
    const line = `${shortUrl}, ${longUrl}`;
    const out = linkKnownHttpUrls(line, [shortUrl, longUrl]);
    const hrefs = [...out.matchAll(new RegExp(`${ESC}\\]8;;(.*?)(?:${ESC}\\\\|\\x07)`, "g"))]
      .map((match) => match[1] ?? "")
      .filter((href) => href.length > 0);
    expect(hrefs).toEqual([shortUrl, longUrl]);
    expect(out).toContain(hyperlink(shortUrl, shortUrl));
    expect(out).toContain(hyperlink(longUrl, longUrl));
    expect(out).not.toContain(`${ESC}]8;;${shortUrl}${ST}${ESC}]8;`);
    expect(stripAnsi(out)).toBe(line);
  });

  test("does not rewrite a URL already wrapped in OSC 8", () => {
    const longUrl = "http://localhost:8080";
    const shortUrl = "http://localhost:80";
    const already = hyperlink(longUrl, longUrl);
    expect(linkKnownHttpUrls(`${already}, ${shortUrl}`, [shortUrl, longUrl])).toBe(
      `${already}, ${hyperlink(shortUrl, shortUrl)}`,
    );
  });

  test("leaves a wrapped head of a longer endpoint plain even when it equals a shorter one", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080";
    const wrapped = `${shortUrl}\n80`;
    expect(linkKnownHttpUrls(wrapped, [shortUrl, longUrl])).toBe(wrapped);
    expect(linkKnownHttpUrls(`${shortUrl}, ${longUrl}`, [shortUrl, longUrl])).toBe(
      `${hyperlink(shortUrl, shortUrl)}, ${hyperlink(longUrl, longUrl)}`,
    );
  });

  test("links a shorter endpoint on its own line when a longer prefix sibling is also known", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080";
    const line = `${shortUrl}\n${longUrl}`;
    const out = linkKnownHttpUrls(line, [shortUrl, longUrl]);
    expect(out).toBe(`${hyperlink(shortUrl, shortUrl)}\n${hyperlink(longUrl, longUrl)}`);
    expect(stripAnsi(out)).toBe(line);
  });

  test("leaves a multi-break wrapped head plain when the first line equals a shorter endpoint", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080/very/long/extra/path";
    const label = "endpoints";
    const width = shortUrl.length + label.length + 3;
    const lines = wrapFieldToWidth(label, longUrl, label.length, width);
    expect(lines[0]?.endsWith(shortUrl)).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
    const text = lines.join("\n");
    const suffix = longUrl.slice(shortUrl.length);
    const afterHead = text.indexOf(shortUrl) + shortUrl.length;
    let rest = afterHead;
    while (rest < text.length && text.charCodeAt(rest) <= 0x20) rest += 1;
    expect(text.slice(rest).startsWith(suffix)).toBe(false);
    expect(text.slice(rest)).toContain("\n");
    const out = linkKnownHttpUrls(text, [shortUrl, longUrl]);
    expect(out).toBe(text);
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("leaves a framed multi-break wrapped head plain when the first line equals a shorter endpoint", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080/very/long/extra/path";
    const label = "endpoints";
    const width = 37;
    const innerWidth = width - 4;
    const lines = wrapFieldToWidth(label, longUrl, label.length, innerWidth - 2);
    expect(lines[0]?.endsWith(shortUrl)).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
    const framed = lines.map((segment) => boxBody(`  ${segment}`, width, styleBoxBottom)).join("\n");
    expect(stripAnsi(framed)).toContain(shortUrl);
    expect(stripAnsi(framed)).not.toContain(longUrl);
    const out = linkKnownHttpUrls(framed, [shortUrl, longUrl]);
    expect(out).toBe(framed);
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("links a shorter endpoint on its own framed line when a longer prefix sibling is also known", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080";
    const other = "http://example.com/other";
    const width = 80;
    const framed = [shortUrl, other]
      .map((url) => boxBody(`  endpoints : ${url}`, width, styleBoxBottom))
      .join("\n");
    const out = linkKnownHttpUrls(framed, [shortUrl, longUrl, other]);
    expect(out).toContain(hyperlink(shortUrl, shortUrl));
    expect(out).toContain(hyperlink(other, other));
    expect(stripAnsi(out)).toBe(stripAnsi(framed));
  });

  test("copies a BEL-terminated OSC 8 span whole instead of re-linking its label", () => {
    const url = "http://localhost:8080";
    const already = `${ESC}]8;;${url}${BEL}${url}${ESC}]8;;${BEL}`;
    expect(linkKnownHttpUrls(`${already} ${url}`, [url])).toBe(`${already} ${hyperlink(url, url)}`);
  });
});
