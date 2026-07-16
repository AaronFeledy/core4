import { describe, expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import * as openTuiModule from "@opentui/core";
import { ManualClock, createTestRenderer } from "@opentui/core/testing";

import { type OpenTuiModuleLike, createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";
import {
  NARROW_PROMPT_FIXTURES,
  NARROW_TREE_FIXTURES,
  PROMPT_FIXTURES,
  TREE_FIXTURES,
  TREE_RESIZE_EVENTS,
} from "./frame-fixtures.ts";
import {
  capturePromptFrame,
  capturePromptSpans,
  captureTreeFrame,
  captureTreeResizeFrame,
  frameName,
  isFrameUpdateMode,
  readOrWriteFrame,
} from "./frame-snapshot-harness.ts";

const ESC = String.fromCharCode(27);
const openTui = openTuiModule satisfies OpenTuiModuleLike<CliRenderer>;

const assertWithin = (captured: string, columns: number): void => {
  expect(captured).not.toContain(ESC);
  for (const line of captured.split("\n")) {
    expect(Bun.stringWidth(line), `line over ${columns} cells:\n${line}`).toBeLessThanOrEqual(columns);
  }
};

const assertFixture = (name: string, captured: string, columns: number): void => {
  assertWithin(captured, columns);
  const golden = readOrWriteFrame(name, captured);
  expect(captured).toBe(golden);
};

const assertBordered = (captured: string): void => {
  const lines = captured.split("\n");
  expect(lines[0]?.startsWith("╭─")).toBe(true);
  expect(lines[0]?.endsWith("╮")).toBe(true);
  expect(lines.at(-1)?.startsWith("╰─")).toBe(true);
  expect(lines.at(-1)?.endsWith("╯")).toBe(true);
  for (const line of lines.slice(1, -1)) {
    expect(line.endsWith("│"), `missing right border:\n${line}`).toBe(true);
  }
};

describe("renderer frame snapshots — task tree", () => {
  for (const fixture of TREE_FIXTURES) {
    test(`${fixture.id} matches its committed 80-column frame`, async () => {
      const columns = 80;
      const first = await captureTreeFrame(fixture.events, columns, 24);
      const second = await captureTreeFrame(fixture.events, columns, 24);
      expect(second).toBe(first);
      assertFixture(frameName(fixture.id, columns), first, columns);
    });
  }

  for (const fixture of NARROW_TREE_FIXTURES) {
    test(`${fixture.id} stays bordered and within width at 40 columns`, async () => {
      const columns = 40;
      const first = await captureTreeFrame(fixture.events, columns, 16);
      const second = await captureTreeFrame(fixture.events, columns, 16);
      expect(second).toBe(first);
      assertBordered(first);
      assertFixture(frameName(fixture.id, columns), first, columns);
    });
  }

  test("mid-tree resize replays a valid narrower frame through the substrate", async () => {
    const { before, after } = await captureTreeResizeFrame(TREE_RESIZE_EVENTS, 100, 60, 24);
    expect(after).not.toBe(before);
    assertFixture(frameName("tree.resize", 60), after, 60);
  });
});

describe("renderer frame snapshots — prompt chrome", () => {
  for (const fixture of PROMPT_FIXTURES) {
    test(`${fixture.id} matches its committed 60-column frame`, async () => {
      const columns = 60;
      const first = await capturePromptFrame(fixture.request, columns, 12);
      const second = await capturePromptFrame(fixture.request, columns, 12);
      expect(second).toBe(first);
      assertFixture(frameName(fixture.id, columns), first, columns);
    });
  }

  for (const fixture of NARROW_PROMPT_FIXTURES) {
    test(`${fixture.id} keeps its title visible and within width at 40 columns`, async () => {
      const columns = 40;
      const first = await capturePromptFrame(fixture.request, columns, 10);
      const second = await capturePromptFrame(fixture.request, columns, 10);
      expect(second).toBe(first);
      const titleRow = first.split("\n").find((row) => row.includes("╭"));
      expect(titleRow?.startsWith("╭─")).toBe(true);
      expect(titleRow?.endsWith("╮")).toBe(true);
      if (fixture.id === "prompt.cjk-narrow") expect(titleRow).toContain("한글 제목");
      assertFixture(frameName(fixture.id, columns), first, columns);
    });
  }

  test("titled border renders in the teal accent (#2dd4bf)", async () => {
    const spans = await capturePromptSpans(
      { prompt: { name: "answer", type: "text", message: "Choose a flavor" }, mode: "normal" },
      60,
      12,
    );
    const borderSpan = spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("╭") && span.text.includes("Choose a flavor"));
    expect(borderSpan).toBeDefined();
    expect(borderSpan?.fg.toInts().slice(0, 3)).toEqual([45, 212, 191]);
  });
});

describe("renderer frame snapshots — driver-owned settlement", () => {
  test("a cancelled prompt removes the driver's keypress listener and destroys the renderer once", async () => {
    const clock = new ManualClock();
    const setup = await createTestRenderer({ width: 60, height: 12, clock });
    let destroyCount = 0;
    const originalDestroy = setup.renderer.destroy.bind(setup.renderer);
    setup.renderer.destroy = () => {
      destroyCount += 1;
      return originalDestroy();
    };
    const driver = createOpenTuiPromptDriver<CliRenderer>({
      loadModule: async () => openTui,
      createRenderer: async () => setup.renderer,
      startRenderer: () => {},
    });
    const pending = driver.readRaw({ prompt: { name: "n", type: "text", message: "Q" }, mode: "normal" });
    await Promise.resolve();
    await Promise.resolve();
    await setup.renderOnce();
    const before = setup.renderer.keyInput.listenerCount("keypress");
    setup.mockInput.pressCtrlC();
    clock.advance(25);
    await setup.renderOnce();
    await expect(pending).rejects.toMatchObject({ name: "PromptCancelledError" });
    expect(destroyCount).toBe(1);
    expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(before - 1);
  });
});

describe("renderer frame snapshots — declined surfaces have no frame", () => {
  test("secret is declined before a renderer is created", async () => {
    let created = false;
    const driver = createOpenTuiPromptDriver<CliRenderer>({
      loadModule: async () => openTui,
      createRenderer: async () => {
        created = true;
        throw new Error("should not create renderer");
      },
    });
    await expect(
      driver.readRaw({ prompt: { name: "s", type: "secret", message: "Secret" }, mode: "normal" }),
    ).rejects.toThrow("driver declines secret");
    expect(created).toBe(false);
    expect(PROMPT_FIXTURES.some((fixture) => /secret/.test(fixture.id))).toBe(false);
  });
});

describe("renderer frame gate discipline", () => {
  test("frame update mode is opt-in only", () => {
    expect(isFrameUpdateMode()).toBe(process.env.LANDO_UPDATE_RENDERER_FRAMES === "1");
  });
});
