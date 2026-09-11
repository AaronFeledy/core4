import { describe, expect, test } from "bun:test";

import { LANDO_LOGO_WIDTHS, pickLandoLogoWidth, renderLandoLogo } from "../src/logo.ts";

describe("Lando logo artwork", () => {
  test("small planets do not grow narrow caps at their top and bottom", () => {
    // These center-adjacent pixels formed two-dot spikes with the old 2x2 sampling.
    for (const [width, capRow] of [
      [8, 4],
      [10, 5],
      [12, 6],
    ] as const) {
      const { lines } = renderLandoLogo(width);
      const masks = [
        [1, 8],
        [2, 16],
        [4, 32],
        [64, 128],
      ] as const;
      for (const y of [capRow, width * 2 - 1 - capRow]) {
        for (const x of [width - 1, width]) {
          const cell = lines[Math.floor(y / 4)]?.charCodeAt(Math.floor(x / 2)) ?? 0x2800;
          const bit = masks[y % 4]?.[x % 2] ?? 0;
          expect((cell - 0x2800) & bit).toBe(0);
        }
      }
    }
  });

  for (const width of LANDO_LOGO_WIDTHS) {
    test(`${width} columns preserves the approved artwork and cell dimensions`, async () => {
      const logo = renderLandoLogo(width);
      const fixture = await Bun.file(`${import.meta.dir}/__frames__/logo-${width}.txt`).text();
      expect(`${logo.content}\n`).toBe(fixture);
      expect(logo.lines).toHaveLength(width / 2);
      for (const line of logo.lines) {
        expect(line).toHaveLength(width);
        expect(line).toMatch(/^[\u2800-\u28ff]+$/u);
      }
    });
  }

  test("selects by both dimensions at every breakpoint", () => {
    for (const [index, width] of LANDO_LOGO_WIDTHS.entries()) {
      const previous = LANDO_LOGO_WIDTHS[index - 1];
      expect(pickLandoLogoWidth(width, width / 2)).toBe(width);
      expect(pickLandoLogoWidth(width - 1, 100)).toBe(previous);
      expect(pickLandoLogoWidth(100, width / 2 - 1)).toBe(previous);
    }
    expect(pickLandoLogoWidth(200, 100)).toBe(64);
    expect(pickLandoLogoWidth(47.9, 24)).toBe(32);
    expect(pickLandoLogoWidth(48, 23.9)).toBe(32);
  });

  test("omits the icon when space is too small or invalid", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pickLandoLogoWidth(value, 40)).toBeUndefined();
      expect(pickLandoLogoWidth(80, value)).toBeUndefined();
    }
    expect(pickLandoLogoWidth(7, 40)).toBeUndefined();
    expect(pickLandoLogoWidth(80, 3)).toBeUndefined();
  });

  test("logo entry points have no eager native imports", async () => {
    for (const path of ["../src/logo.ts", "../src/opentui/lando-logo.ts"]) {
      const source = await Bun.file(`${import.meta.dir}/${path}`).text();
      const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
      expect(imports.filter((entry) => entry.path.startsWith("@opentui/"))).toEqual([]);
    }
  });
});
