import { describe, expect, test } from "bun:test";
import * as openTui from "@opentui/core";

import {
  ansiToNativeStyledText,
  hasNativeStyledText,
  isInPlaceTerminalUpdate,
  stripNonSgrControls,
} from "../src/opentui/ansi-styled-text.ts";

const ESC = String.fromCharCode(27);

const sgr = (code: number, text: string): string => `${ESC}[${String(code)}m${text}${ESC}[0m`;

const firstForeground = (content: string) => {
  if (!hasNativeStyledText(openTui)) {
    throw new TypeError("OpenTUI module is missing the styled-text surface.");
  }
  const chunk = ansiToNativeStyledText(openTui, content).chunks[0];
  if (chunk === undefined) {
    throw new TypeError("Expected a styled-text chunk.");
  }
  return chunk.fg;
};

describe("ansiToNativeStyledText palette intent", () => {
  test("maps status SGR colors to indexed palette slots and keeps the Lando rail as explicit RGB", () => {
    // Given SGR 31/32/33/36 status accents and SGR 95 Lando rail
    const statusColors = [
      { code: 31, slot: 1 },
      { code: 32, slot: 2 },
      { code: 33, slot: 3 },
      { code: 36, slot: 6 },
    ] as const;

    // When converting those sequences through the OpenTUI adapter
    const statusForegrounds = statusColors.map(({ code, slot }) => ({
      slot,
      fg: firstForeground(sgr(code, "status")),
    }));
    const railForeground = firstForeground(sgr(95, "│"));

    // Then status colors keep terminal palette intent and the rail stays explicit RGB
    for (const { slot, fg } of statusForegrounds) {
      expect(fg?.intent).toBe("indexed");
      expect(fg?.slot).toBe(slot);
    }
    expect(railForeground?.intent).toBe("rgb");
  });
});

describe("stripNonSgrControls", () => {
  test("preserves carriage returns used by in-place progress bars", () => {
    expect(stripNonSgrControls("  53/108 [=====>----]  49%\r")).toBe("  53/108 [=====>----]  49%\r");
  });

  test("strips line-cursor CSI by default", () => {
    expect(stripNonSgrControls(`${ESC}[1G${ESC}[2K  53/108`)).toBe("  53/108");
  });

  test("preserves line-cursor CSI when allowCursor is set", () => {
    const bar = `${ESC}[1G${ESC}[2K  53/108 [=====>----]  49%`;
    expect(stripNonSgrControls(bar, { allowCursor: true })).toBe(bar);
  });

  test("strips erase-display CSI even when allowCursor is set", () => {
    expect(stripNonSgrControls(`${ESC}[2J${ESC}[10Akeep`, { allowCursor: true })).toBe("keep");
  });
});

describe("isInPlaceTerminalUpdate", () => {
  test("treats unterminated chunks as in-place, including Composer first frames", () => {
    expect(isInPlaceTerminalUpdate("  0/108 [>---------------------------]   0%")).toBe(true);
    expect(isInPlaceTerminalUpdate("  53/108 [=====>----]  49%\r")).toBe(true);
    expect(isInPlaceTerminalUpdate(`${ESC}[1G${ESC}[2K  53/108 [=====>----]  49%`)).toBe(true);
    expect(isInPlaceTerminalUpdate("log")).toBe(true);
  });

  test("does not treat newline-terminated lines as in-place", () => {
    expect(isInPlaceTerminalUpdate("log\n")).toBe(false);
    expect(isInPlaceTerminalUpdate(`${ESC}[1G${ESC}[2K  53/108\n`)).toBe(false);
    expect(isInPlaceTerminalUpdate("")).toBe(false);
  });
});
