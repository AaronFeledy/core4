import { describe, expect, test } from "bun:test";

import * as openTui from "@opentui/core";

import { hasNativeStyledText } from "../src/opentui/ansi-styled-text.ts";
import {
  type LiveRegionStdout,
  type OpenTuiLiveRegionModuleLike,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";
import { createRecordingStdout } from "./live-region-test-kit.ts";

const COMPLETED = "completed-progress-line";
const RESULT = "APP STARTED result-line";
const ESC = String.fromCharCode(27);
const VIEWPORT_WIPE = new RegExp(`${ESC}\\[(?:[23]J|H${ESC}\\[[0123]?J|1;1H${ESC}\\[[0123]?J)`);

const isLiveRegionModule = (value: unknown): value is OpenTuiLiveRegionModuleLike =>
  value !== null &&
  typeof value === "object" &&
  "createCliRenderer" in value &&
  typeof value.createCliRenderer === "function" &&
  "BoxRenderable" in value &&
  typeof value.BoxRenderable === "function" &&
  "TextRenderable" in value &&
  typeof value.TextRenderable === "function" &&
  hasNativeStyledText(value);

const createProductionLiveRegion = async (stdout: LiveRegionStdout) => {
  let createConfig: Record<string, unknown> | undefined;
  const wrapped: unknown = {
    ...openTui,
    createCliRenderer: async (config: Record<string, unknown>) => {
      createConfig = config;
      throw new Error("inline teardown must not construct an OpenTUI renderer");
    },
  };
  if (!isLiveRegionModule(wrapped)) {
    throw new TypeError("Wrapped OpenTUI module is missing the live-region surface.");
  }

  const controller = await createLiveRegionController(
    { stdout, width: stdout.columns ?? 80, height: stdout.rows ?? 24 },
    { loadModule: async () => wrapped },
  );
  return { controller, createConfig };
};

describe("LiveRegionController production OpenTUI teardown", () => {
  test("keeps committed scrollback and a post-dispose result without a viewport wipe", async () => {
    const recording = createRecordingStdout(80, 24);
    resetLiveRegionModuleCacheForTests();
    const { controller, createConfig } = await createProductionLiveRegion(recording.stdout);

    expect(createConfig).toBeUndefined();
    expect(createConfig?.screenMode).not.toBe("split-footer");

    controller.commitScrollback(COMPLETED);
    controller.setFooter([]);
    await controller.dispose();
    recording.stdout.write(`${RESULT}\n`);

    const output = recording.captured();
    expect(output).toContain(COMPLETED);
    expect(output).toContain(RESULT);
    const afterCompleted = output.slice(output.lastIndexOf(COMPLETED));
    expect(afterCompleted).toContain(RESULT);
    expect(afterCompleted).not.toMatch(VIEWPORT_WIPE);
  });
});
