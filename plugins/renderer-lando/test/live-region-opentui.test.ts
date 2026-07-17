import { describe, expect, test } from "bun:test";

import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";

const createFixture = async (width = 80, height = 24, activeTerminal = false) => {
  const clock = new ManualClock();
  const setup = await createTestRenderer({
    clock,
    exitOnCtrlC: false,
    externalOutputMode: "capture-stdout",
    footerHeight: 4,
    gatherStats: true,
    height,
    maxFps: 60,
    screenMode: "split-footer",
    targetFps: 60,
    width,
  });
  if (activeTerminal) await setup.renderer.setupTerminal();
  const controller = await createLiveRegionController(
    { stdout: process.stdout, width, height, footerHeight: 4 },
    {
      createRenderer: async () => setup.renderer,
    },
  );
  return { clock, controller, setup };
};

describe("LiveRegionController with the OpenTUI test renderer", () => {
  test("initializes captured split-footer at the physical bottom boundary", async () => {
    const setup = await createTestRenderer({
      exitOnCtrlC: false,
      externalOutputMode: "passthrough",
      footerHeight: 4,
      height: 24,
      screenMode: "main-screen",
      width: 80,
    });
    const controller = await createLiveRegionController(
      { stdout: process.stdout, width: 80, height: 24, footerHeight: 4 },
      { createRenderer: async () => setup.renderer },
    );

    expect(setup.renderer.screenMode).toBe("split-footer");
    expect(setup.renderer.externalOutputMode).toBe("capture-stdout");
    expect(Reflect.get(setup.renderer, "renderOffset")).toBe(20);
    controller.commitScrollback("sparse output");
    await setup.renderOnce();
    controller.setFooter(["one", "two"]);
    await setup.renderOnce();
    expect(Reflect.get(setup.renderer, "renderOffset")).toBe(22);
    controller.dispose();
  });

  test("converts task-tree ANSI into native styled text without control-byte clipping", async () => {
    const { controller, setup } = await createFixture(40, 12);
    const escapeCharacter = String.fromCharCode(27);
    controller.setFooter([
      `${escapeCharacter}[95m│${escapeCharacter}[0m ${escapeCharacter}[2m한글 작업 상태${escapeCharacter}[22m ${escapeCharacter}[36mONLINE${escapeCharacter}[0m`,
    ]);
    await setup.renderOnce();

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const text = spans.map((span) => span.text).join("");
    expect(text).toContain("│ 한글 작업 상태 ONLINE");
    expect(text).not.toContain(escapeCharacter);
    expect(spans.some((span) => span.text.includes("한글 작업 상태") && span.attributes !== 0)).toBe(true);
    controller.dispose();
  });

  test("drops non-SGR terminal controls from footer and scrollback content", async () => {
    const { controller, setup } = await createFixture(80, 12);
    const escapeCharacter = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    const payload = [
      "safe",
      `${escapeCharacter}]52;c;U0VDUkVU${bell}`,
      `${escapeCharacter}]0;spoofed title${escapeCharacter}\\`,
      `${escapeCharacter}]8;;https://example.invalid${escapeCharacter}\\link${escapeCharacter}]8;;${escapeCharacter}\\`,
      `${escapeCharacter}[2J${escapeCharacter}[10A`,
      "tail",
    ].join("");

    controller.commitScrollback(payload);
    controller.setFooter([payload]);
    await setup.renderOnce();

    const footerText = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .map((span) => span.text)
      .join("");
    const scrollbackText = setup.externalOutput.takeText();
    for (const text of [footerText, scrollbackText]) {
      expect(text).toContain("safelinktail");
      expect(text).not.toContain(escapeCharacter);
      expect(text).not.toContain(bell);
      expect(text).not.toContain("U0VDUkVU");
      expect(text).not.toContain("spoofed title");
      expect(text).not.toContain("example.invalid");
    }
    controller.dispose();
  });

  test("full-tail transition returns to split-footer with the current frame intact", async () => {
    const { controller, setup } = await createFixture();
    controller.setFooter(["build running", "appserver online"]);
    await setup.renderOnce();

    controller.enterFullTail();
    expect(setup.renderer.screenMode).toBe("alternate-screen");
    expect(setup.renderer.externalOutputMode).toBe("passthrough");
    controller.exitFullTail();
    await setup.renderOnce();

    expect(setup.renderer.screenMode).toBe("split-footer");
    expect(setup.renderer.externalOutputMode).toBe("capture-stdout");
    expect(setup.captureCharFrame()).toContain("appserver online");
    controller.dispose();
  });

  test("terminal resize replays scrollback and reflows the live footer", async () => {
    const { controller, setup } = await createFixture(80, 24, true);
    controller.commitScrollback("first committed line");
    controller.setFooter(["a deliberately long running task line that reflows at the narrower width"]);
    await setup.renderOnce();
    setup.externalOutput.take();

    setup.resize(40, 12);
    await setup.renderOnce();

    expect(setup.externalOutput.takeText()).toContain("first committed line");
    expect(setup.renderer.terminalWidth).toBe(40);
    expect(setup.renderer.terminalHeight).toBe(12);
    const visibleText = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .map((span) => span.text)
      .join("");
    expect(visibleText).toContain("deliberately long running task");
    controller.dispose();
  });

  test("live requests use the real substrate counter and retain the 30 fps cap", async () => {
    const { clock, controller, setup } = await createFixture();
    controller.setFooter(["spinner frame"]);
    await setup.renderOnce();
    const before = setup.getNativeStats().nativeFrameCount;
    controller.requestLive();
    clock.advance(34);
    await setup.renderOnce();

    expect(setup.renderer.liveRequestCount).toBe(1);
    expect(setup.renderer.targetFps).toBeLessThanOrEqual(30);
    expect(setup.renderer.maxFps).toBeLessThanOrEqual(30);
    expect(setup.getNativeStats().nativeFrameCount).toBeGreaterThan(before);
    controller.dropLive();
    expect(setup.renderer.liveRequestCount).toBe(0);
    controller.dispose();
  });
});
