import { describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteStream } from "node:tty";

import * as openTui from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { hasNativeStyledText } from "../src/opentui/ansi-styled-text.ts";
import {
  type OpenTuiLiveRegionModuleLike,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";

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

const createRecordingStdout = async (columns: number, rows: number) => {
  const directory = await mkdtemp(join(tmpdir(), "lando-live-region-teardown-"));
  const outputPath = join(directory, "stdout.log");
  const fd = openSync(outputPath, "w");
  const stdout = new WriteStream(fd);
  stdout.columns = columns;
  stdout.rows = rows;
  return {
    stdout,
    read: async (): Promise<string> => {
      await new Promise<void>((resolve) => {
        stdout.end(() => resolve());
      });
      closeSync(fd);
      return readFile(outputPath, "utf8");
    },
    cleanup: async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const createProductionLiveRegion = async (stdout: NodeJS.WriteStream) => {
  let createConfig: Record<string, unknown> | undefined;
  const wrapped: unknown = {
    ...openTui,
    createCliRenderer: async (config: Record<string, unknown>) => {
      createConfig = config;
      const setup = await createTestRenderer({
        ...config,
        bufferedOutput: "stdout",
        stdout,
      });
      await setup.renderer.setupTerminal();
      return setup.renderer;
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
    const recording = await createRecordingStdout(80, 24);
    try {
      resetLiveRegionModuleCacheForTests();
      const { controller, createConfig } = await createProductionLiveRegion(recording.stdout);

      expect(createConfig).toBeUndefined();
      expect(createConfig?.screenMode).not.toBe("split-footer");

      controller.commitScrollback(COMPLETED);
      controller.setFooter([]);
      await controller.dispose();
      recording.stdout.write(`${RESULT}\n`);

      const output = await recording.read();
      expect(output).toContain(COMPLETED);
      expect(output).toContain(RESULT);
      const afterCompleted = output.slice(output.lastIndexOf(COMPLETED));
      expect(afterCompleted).toContain(RESULT);
      expect(afterCompleted).not.toMatch(VIEWPORT_WIPE);
    } finally {
      await recording.cleanup();
    }
  });
});
