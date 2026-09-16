import { describe, expect, test } from "bun:test";

import * as openTui from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { LANDO_LOGO_WIDTHS, renderLandoLogo } from "../src/logo.ts";
import { createLandoLogo } from "../src/opentui/lando-logo.ts";

const expectedFrame = (
  columns: number,
  rows: number,
  width?: (typeof LANDO_LOGO_WIDTHS)[number],
  round = Math.floor,
) => {
  const frame = Array.from({ length: rows }, () => " ".repeat(columns));
  if (width !== undefined) {
    const logo = renderLandoLogo(width);
    const left = round((columns - logo.width) / 2);
    const top = round((rows - logo.height) / 2);
    for (const [row, line] of logo.lines.entries()) {
      frame[top + row] = " ".repeat(left) + line + " ".repeat(columns - left - logo.width);
    }
  }
  return `${frame.join("\n")}\n`;
};

const paint = async (setup: Awaited<ReturnType<typeof createTestRenderer>>) => {
  await setup.renderOnce();
  await setup.renderer.idle();
};

describe("OpenTUI Lando logo", () => {
  for (const width of LANDO_LOGO_WIDTHS) {
    test(`${width} columns draws a complete centered icon in native palette pink`, async () => {
      const setup = await createTestRenderer({
        width: 80,
        height: 40,
        screenMode: "alternate-screen",
        useThread: false,
      });
      try {
        const frame = createLandoLogo(openTui, setup.renderer, {
          width,
          height: width / 2,
        });
        const center = new openTui.BoxRenderable(setup.renderer, {
          width: "100%",
          height: "100%",
          justifyContent: "center",
          alignItems: "center",
        });
        center.add(frame);
        setup.renderer.root.add(center);
        await paint(setup);
        // Yoga rounds a centered container's half-cell offset to the nearest cell.
        expect(setup.captureCharFrame()).toBe(expectedFrame(80, 40, width, Math.round));
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        const ink = spans.filter((span) => /[\u2801-\u28ff]/u.test(span.text));
        expect(ink.length).toBeGreaterThan(0);
        for (const span of ink) {
          expect(span.fg.intent).toBe("indexed");
          expect(span.fg.slot).toBe(13);
        }
      } finally {
        setup.renderer.destroy();
      }
    });
  }

  test("adapts to panel size, padding, terminal resize, and removal without stale cells", async () => {
    const setup = await createTestRenderer({
      width: 80,
      height: 40,
      screenMode: "alternate-screen",
      useThread: false,
    });
    try {
      const panel = new openTui.BoxRenderable(setup.renderer, {
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      });
      const logo = createLandoLogo(openTui, setup.renderer);
      panel.add(logo);
      setup.renderer.root.add(panel);
      await paint(setup);
      expect(setup.captureCharFrame()).toBe(expectedFrame(80, 40, 64));

      logo.width = 50;
      logo.height = 26;
      await paint(setup);
      expect(setup.captureCharFrame()).toBe(expectedFrame(80, 40, 48));

      logo.padding = 2;
      await paint(setup);
      expect(setup.captureCharFrame()).toBe(expectedFrame(80, 40, 32));

      logo.width = 8;
      logo.height = 4;
      await paint(setup);
      expect(setup.captureCharFrame()).toBe(expectedFrame(80, 40));

      logo.padding = 0;
      logo.width = "100%";
      logo.height = "100%";
      setup.resize(40, 20);
      await paint(setup);
      expect(setup.captureCharFrame()).toBe(expectedFrame(40, 20, 32));

      logo.destroyRecursively();
      await paint(setup);
      expect(setup.captureCharFrame()).toBe(expectedFrame(40, 20));
      expect(setup.renderer.isDestroyed).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });
});
