import { describe, expect, test } from "bun:test";

import { displayWidth, graphemes, takeWidth, truncateToWidth } from "../src/terminal-width.ts";

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
});
