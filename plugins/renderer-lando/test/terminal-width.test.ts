import { describe, expect, test } from "bun:test";

import {
  displayWidth,
  graphemes,
  takeWidth,
  truncateToWidth,
  wrapToWidth,
  wrapWordsToWidth,
} from "../src/terminal-width.ts";

describe("terminal-width primitive", () => {
  test("displayWidth counts CJK as two cells and ignores ANSI", () => {
    expect(displayWidth("한글🙂")).toBe(6);
    expect(displayWidth("ascii")).toBe(5);
    const esc = String.fromCharCode(27);
    expect(displayWidth(`${esc}[36mabc${esc}[0m`)).toBe(3);
  });

  test("graphemes never split a wide cluster", () => {
    expect(graphemes("한a🙂")).toEqual(["한", "a", "🙂"]);
  });

  test("takeWidth stops on grapheme boundaries within the cell budget", () => {
    expect(takeWidth("한글자", 3)).toEqual(["한", "글자"]);
    expect(takeWidth("abcd", 2)).toEqual(["ab", "cd"]);
    expect(takeWidth("🙂x", 1)).toEqual(["", "🙂x"]);
  });

  test("truncateToWidth reserves the ellipsis and stays within the budget", () => {
    const truncated = truncateToWidth("한글자막", 5);
    expect(truncated).toBe("한글…");
    expect(displayWidth(truncated)).toBeLessThanOrEqual(5);
    expect(truncateToWidth("short", 10)).toBe("short");
  });

  test("wrapToWidth keeps every line within the cell budget and never splits graphemes", () => {
    const lines = wrapToWidth("한글 제목 🙂 extra", 8);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(8);
    }
    expect(lines.join("")).toBe("한글 제목 🙂 extra");
    expect(lines.some((line) => line.includes("한"))).toBe(true);
    expect(lines.some((line) => line.includes("🙂"))).toBe(true);
  });

  test("wrapToWidth returns a single empty line for empty text or a non-positive budget", () => {
    expect(wrapToWidth("", 8)).toEqual([""]);
    expect(wrapToWidth("abc", 0)).toEqual([""]);
    expect(wrapToWidth("abc", -1)).toEqual([""]);
  });

  test("wrapWordsToWidth breaks on spaces and does not split a fitting word", () => {
    const lines = wrapWordsToWidth("Joomla with Apache PHP", 14);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(14);
    }
    expect(lines.some((line) => line.includes("Apach") && !line.includes("Apache"))).toBe(false);
    expect(lines.join(" ").replaceAll("  ", " ")).toContain("Apache");
  });

  test("wrapWordsToWidth hard-splits a token wider than the budget", () => {
    const lines = wrapWordsToWidth("abcdefghij", 4);
    expect(lines).toEqual(["abcd", "efgh", "ij"]);
  });
});
