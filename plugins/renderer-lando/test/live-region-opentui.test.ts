import { describe, expect, test } from "bun:test";

import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import { createLiveRegionController } from "../src/opentui/live-region-controller.ts";
import { createCapturingStdout } from "./live-region-test-kit.ts";

const ESC = String.fromCharCode(27);
const CUP_ROW_24 = new RegExp(`${ESC}\\[24;|${ESC}\\[24H`);
const REWIND = new RegExp(`${ESC}\\[[0-9;]*[AJ]`);
const CSI_A = new RegExp(`${ESC}\\[[0-9;]*A`);

const createInlineFixture = async (width = 80, height = 24) => {
  const writes: string[] = [];
  const stdout = createCapturingStdout(writes);
  let createRendererCalls = 0;
  const controller = await createLiveRegionController(
    { stdout, width, height },
    {
      createRenderer: async () => {
        createRendererCalls += 1;
        throw new Error("createRenderer must not run on the default inline path.");
      },
    },
  );
  return { controller, createRendererCalls: () => createRendererCalls, writes };
};

const createFullTailFixture = async (width = 80, height = 24) => {
  const clock = new ManualClock();
  const writes: string[] = [];
  const stdout = createCapturingStdout(writes);
  const setup = await createTestRenderer({
    clock,
    exitOnCtrlC: false,
    externalOutputMode: "passthrough",
    height,
    maxFps: 60,
    screenMode: "alternate-screen",
    targetFps: 60,
    width,
  });
  const cursorPins: Array<readonly [number, number]> = [];
  const setCursorPosition = setup.renderer.setCursorPosition.bind(setup.renderer);
  setup.renderer.setCursorPosition = (x, y, visible) => {
    cursorPins.push([x, y]);
    setCursorPosition(x, y, visible);
  };
  const controller = await createLiveRegionController(
    { stdout, width, height },
    {
      createRenderer: async () => setup.renderer,
    },
  );
  return { clock, controller, cursorPins, setup, writes };
};

describe("LiveRegionController with the OpenTUI test renderer", () => {
  test("paints the live region at the cursor instead of pinning a split footer", async () => {
    const { controller, createRendererCalls, writes } = await createInlineFixture();

    controller.commitScrollback("sparse output");
    controller.setFooter(["one", "two"]);

    const bytes = writes.join("");
    expect(bytes).toContain("one");
    expect(bytes).toContain("two");
    expect(bytes).not.toMatch(CUP_ROW_24);
    expect(createRendererCalls()).toBe(0);
    await controller.dispose();
  });

  test("converts task-tree ANSI into native styled text without control-byte clipping", async () => {
    const { controller, writes } = await createInlineFixture(40, 12);
    const escapeCharacter = String.fromCharCode(27);
    controller.setFooter([
      `${escapeCharacter}[95m│${escapeCharacter}[0m ${escapeCharacter}[2m한글 작업 상태${escapeCharacter}[22m ${escapeCharacter}[36mONLINE${escapeCharacter}[0m`,
    ]);

    const text = writes.join("");
    expect(text).toContain("│");
    expect(text).toContain("한글 작업 상태");
    expect(text).toContain("ONLINE");
    await controller.dispose();
  });

  test("drops non-SGR terminal controls from footer and scrollback content", async () => {
    const { controller, writes } = await createInlineFixture(80, 12);
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

    const text = writes.join("");
    expect(text).toContain("safe");
    expect(text).toContain("link");
    expect(text).toContain("tail");
    expect(text).not.toContain(bell);
    expect(text).not.toContain("U0VDUkVU");
    expect(text).not.toContain("spoofed title");
    expect(text).not.toContain("example.invalid");
    await controller.dispose();
  });

  test("commits remediation-shaped multiline styled output as distinct native rows", async () => {
    const { controller, writes } = await createInlineFixture(80, 12);

    controller.commitScrollback("\u001b[31mBuild failed\u001b[0m\nRemediation: Run lando setup");

    const text = writes.join("");
    expect(text).toContain("Build failed");
    expect(text).toContain("Remediation: Run lando setup");
    await controller.dispose();
  });

  test("retires the split footer without a reserved row and reactivates it", async () => {
    const { controller, writes } = await createInlineFixture(80, 12);
    controller.setFooter(["building"]);
    writes.length = 0;

    controller.setFooter([]);

    expect(writes.join("")).not.toMatch(REWIND);

    writes.length = 0;
    controller.setFooter(["restarted"]);

    expect(writes.join("")).toContain("restarted");
    expect(writes.join("")).not.toMatch(CSI_A);
    await controller.dispose();
  });

  test("full-tail transition returns to split-footer with the current frame intact", async () => {
    const { controller, cursorPins, writes } = await createFullTailFixture();
    controller.setFooter(["build running", "appserver online"]);

    await controller.enterFullTail();
    await controller.exitFullTail();

    expect(writes.join("")).toContain("appserver online");
    expect(cursorPins).not.toContainEqual([1, 24]);
    await controller.dispose();
  });

  test("terminal resize replays scrollback and reflows the live footer", async () => {
    const writes: string[] = [];
    const stdout = createCapturingStdout(writes);
    const lines = ["a deliberately long running task line that reflows at the narrower width"];
    const controller = await createLiveRegionController({
      stdout,
      width: 80,
      height: 24,
      onResize: () => {
        controller.setFooter(lines);
      },
    });
    controller.commitScrollback("first committed line");
    controller.setFooter(lines);

    controller.resize(40, 12);

    const text = writes.join("");
    expect(text).toContain("first committed line");
    expect(text).toContain("deliberately long running task");
    await controller.dispose();
  });

  test("live requests use the real substrate counter and retain the 30 fps cap", async () => {
    const { clock, controller, setup } = await createFullTailFixture();
    await controller.enterFullTail();
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
    await controller.dispose();
  });
});
