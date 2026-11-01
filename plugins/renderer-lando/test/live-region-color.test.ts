import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteStream } from "node:tty";

import * as openTui from "@opentui/core";
import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import { hasNativeStyledText } from "../src/opentui/ansi-styled-text.ts";
import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";
import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";

const chromaticSgr = new RegExp(
  `${String.fromCharCode(27)}\\[(?:\\d*[;:])*(?:3[0-8]|4[0-8]|9[0-7]|10[0-7])(?:[;:]\\d*)*m`,
  "g",
);

test.each([true, false])("expanded native frame honors noColor=%j", async (noColor) => {
  // Given: the controller receives the same resolved policy as its task-tree painter.
  const root = mkdtempSync(join(tmpdir(), "lando-full-tail-color-"));
  const path = join(root, "output");
  const fd = openSync(path, "w");
  const stdout = new WriteStream(fd);
  stdout.write = (chunk: string | Uint8Array) => {
    writeSync(fd, Buffer.from(chunk));
    return true;
  };
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
  resetLiveRegionModuleCacheForTests();
  const nativeModule: unknown = openTui;
  if (typeof nativeModule !== "object" || nativeModule === null || !hasNativeStyledText(nativeModule)) {
    throw new Error("OpenTUI styled-text surface unavailable");
  }
  const options = { stdout, width: 60, height: 12, noColor };
  const controller = await createLiveRegionController(options, {
    loadModule: async () => ({
      ...nativeModule,
      RGBA: openTui.RGBA,
      BoxRenderable: class extends openTui.BoxRenderable {
        constructor(context: unknown, options: Record<string, unknown>) {
          if (!(context instanceof openTui.CliRenderer)) throw new TypeError("Expected native renderer");
          super(context, options);
        }
      },
      TextRenderable: class extends openTui.TextRenderable {
        constructor(context: unknown, options: Record<string, unknown>) {
          if (!(context instanceof openTui.CliRenderer)) throw new TypeError("Expected native renderer");
          super(context, options);
        }
      },
      createCliRenderer: async (config: Record<string, unknown>) => {
        setup = await createTestRenderer({
          ...config,
          width: 60,
          height: 12,
          clock: new ManualClock(),
          bufferedOutput: "stdout",
        });
        return setup.renderer;
      },
    }),
  });
  const rail = noColor ? "" : "\x1b[95m";
  const lines = [`${rail}╭─\x1b[0m \x1b[1mBuild\x1b[22m`, "│ compiling", "╰─ tail"];
  try {
    controller.setFooter(lines);
    expect(readFileSync(path, "utf8").match(chromaticSgr)?.length ?? 0).toBe(noColor ? 0 : 1);
    // When: expand through the real controller and paint the native alternate screen.
    await controller.enterFullTail();
    if (setup === undefined) throw new Error("Full-tail did not acquire OpenTUI");
    await setup.renderOnce();
    // Then: text survives and every native cell, including blanks, obeys the policy.
    expect(setup.captureCharFrame()).toContain("compiling");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.length).toBeGreaterThan(0);
    if (noColor) {
      expect(readFileSync(path, "utf8").match(chromaticSgr) ?? []).toHaveLength(0);
      expect(spans.every((span) => span.fg.intent === "default" && span.bg.intent === "default")).toBe(true);
    } else {
      expect(readFileSync(path, "utf8").match(chromaticSgr)?.length).toBeGreaterThan(1);
      const railSpan = spans.find((span) => span.text.includes("╭"));
      expect(railSpan?.fg.toInts()).toEqual(openTui.brightMagenta("rail").fg?.toInts());
    }
  } finally {
    await controller.dispose();
    stdout.destroy();
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
    resetLiveRegionModuleCacheForTests();
  }
});
