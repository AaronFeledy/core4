import { expect, test } from "bun:test";

import { terminalPalette } from "@lando/renderer/palette";

test("monochrome suppresses chromatic ink but retains typography and resets", () => {
  // Given
  const colored = terminalPalette(true);
  // When
  const monochrome = terminalPalette(false);
  // Then
  for (const token of ["cyan", "pink", "green", "amber", "red"] as const) {
    expect(colored[token]).not.toBe("");
    expect(monochrome[token]).toBe("");
  }
  for (const token of ["reset", "bold", "dim", "dimReset", "defaultFg"] as const) {
    expect(monochrome[token]).toBe(colored[token]);
    expect(monochrome[token]).not.toBe("");
  }
});

test("shared palettes cannot be mutated by a painter", () => {
  // Given / When
  const palettes = [terminalPalette(true), terminalPalette(false)];
  // Then
  for (const palette of palettes) expect(Object.isFrozen(palette)).toBe(true);
});
