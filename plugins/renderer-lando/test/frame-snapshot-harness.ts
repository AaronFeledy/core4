/**
 * Headless frame-snapshot harness for the bundled `@lando/renderer-lando` TTY
 * substrate. Every surface is captured through the substrate's own headless
 * test renderer (`@opentui/core/testing` `createTestRenderer`, memory-buffered
 * `captureCharFrame`/`captureSpans`) with no PTY, provider, network, or host
 * mutation.
 *
 * Task-tree frames come from the pure `TaskTreeViewModel` logical frame mounted
 * through the real renderer; prompt frames come from the real
 * `createOpenTuiPromptDriver` building against the same renderer.
 *
 * Fixtures are committed under `__frames__/` and read fail-closed: a missing
 * fixture is a hard failure in the default path and is only (re)written under
 * `LANDO_UPDATE_RENDERER_FRAMES=1`, so CI can never silently regenerate one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LandoEvent } from "@lando/sdk/events";
import type { CliRenderer } from "@opentui/core";
import * as openTuiModule from "@opentui/core";
import { ManualClock, type TestRenderer, createTestRenderer } from "@opentui/core/testing";

import { type OpenTuiModuleLike, createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";
import { TaskTreeViewModel } from "../src/task-tree-tail.ts";

const openTui = openTuiModule satisfies OpenTuiModuleLike<CliRenderer>;

type PromptCaptureSetup = Awaited<ReturnType<typeof createTestRenderer>>;

/** Trailing padding and blank tail lines are dropped so a fixture reads as the visible frame. */
export const normalizeFrame = (frame: string): string => {
  const lines = frame.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
};

const mountLines = (renderer: TestRenderer, lines: ReadonlyArray<string>, width: number) => {
  const column = new openTui.BoxRenderable(renderer, { id: "frame-mount", flexDirection: "column", width });
  for (const [index, line] of lines.entries()) {
    column.add?.(
      new openTui.TextRenderable(renderer, {
        id: `frame-line-${index}`,
        content: line.length > 0 ? line : " ",
      }),
    );
  }
  renderer.root.add?.(column);
  return column;
};

/** Capture the mounted `TaskTreeViewModel` logical frame for an event sequence at a fixed size. */
export const captureTreeFrame = async (
  events: ReadonlyArray<LandoEvent>,
  width: number,
  height: number,
): Promise<string> => {
  const painter = new TaskTreeViewModel({ terminalColumns: width });
  for (const event of events) painter.apply(event);
  const setup = await createTestRenderer({ width, height, clock: new ManualClock() });
  mountLines(setup.renderer, painter.snapshot().frameLines, width);
  await setup.renderOnce();
  const frame = normalizeFrame(setup.captureCharFrame());
  setup.renderer.destroy();
  return frame;
};

/** Capture the mounted tree frame after a substrate resize, re-wrapped to the new width. */
export const captureTreeResizeFrame = async (
  events: ReadonlyArray<LandoEvent>,
  from: number,
  to: number,
  height: number,
): Promise<{ readonly before: string; readonly after: string }> => {
  const setup = await createTestRenderer({ width: from, height, clock: new ManualClock() });
  const beforePainter = new TaskTreeViewModel({ terminalColumns: from });
  for (const event of events) beforePainter.apply(event);
  const beforeFrame = mountLines(setup.renderer, beforePainter.snapshot().frameLines, from);
  await setup.renderOnce();
  const before = normalizeFrame(setup.captureCharFrame());

  setup.resize(to, height);
  setup.renderer.root.remove(beforeFrame);
  const afterPainter = new TaskTreeViewModel({ terminalColumns: to });
  for (const event of events) afterPainter.apply(event);
  mountLines(setup.renderer, afterPainter.snapshot().frameLines, to);
  await setup.renderOnce();
  const after = normalizeFrame(setup.captureCharFrame());
  setup.renderer.destroy();
  return { before, after };
};

/**
 * Build the prompt, capture it, then send Ctrl-C so the driver's own `finally`
 * removes its listeners and destroys the renderer exactly once. The harness
 * never tears the renderer down itself and never swallows the pending read.
 */
const settlePromptCapture = async <T>(
  request: Record<string, unknown>,
  width: number,
  height: number,
  capture: (setup: PromptCaptureSetup) => T,
): Promise<T> => {
  const clock = new ManualClock();
  const setup = await createTestRenderer({ width, height, clock });
  const driver = createOpenTuiPromptDriver<CliRenderer>({
    loadModule: async () => openTui,
    createRenderer: async () => setup.renderer,
    startRenderer: () => {},
  });
  const pending = driver.readRaw(request);
  await Promise.resolve();
  await Promise.resolve();
  await setup.renderOnce();
  const captured = capture(setup);
  setup.mockInput.pressCtrlC();
  clock.advance(25);
  await setup.renderOnce();
  await pending.then(
    () => undefined,
    () => undefined,
  );
  return captured;
};

/** Capture the prompt chrome the renderer draws for a single request at a fixed size. */
export const capturePromptFrame = (
  request: Record<string, unknown>,
  width: number,
  height: number,
): Promise<string> =>
  settlePromptCapture(request, width, height, (setup) => normalizeFrame(setup.captureCharFrame()));

/** Capture the styled spans of the prompt chrome (colour evidence for the accented border). */
export const capturePromptSpans = (
  request: Record<string, unknown>,
  width: number,
  height: number,
): Promise<ReturnType<PromptCaptureSetup["captureSpans"]>> =>
  settlePromptCapture(request, width, height, (setup) => setup.captureSpans());

const FRAME_DIR = resolve(import.meta.dirname, "__frames__");

/** Opt-in flag that regenerates committed frame fixtures; CI never sets it. */
export const isFrameUpdateMode = (): boolean => process.env.LANDO_UPDATE_RENDERER_FRAMES === "1";

export const frameName = (id: string, columns: number): string => `${id}.${columns}col.txt`;

/** Read a committed frame fixture, or write it only under the opt-in update flag. */
export const readOrWriteFrame = (name: string, captured: string): string => {
  const path = resolve(FRAME_DIR, name);
  if (isFrameUpdateMode()) {
    writeFileSync(path, `${captured}\n`, "utf8");
    return captured;
  }
  try {
    return readFileSync(path, "utf8").replace(/\n$/, "");
  } catch {
    throw new Error(
      `Missing renderer frame fixture: ${name}. Regenerate with LANDO_UPDATE_RENDERER_FRAMES=1 bun test plugins/renderer-lando/test/frame-snapshots.test.ts`,
    );
  }
};
