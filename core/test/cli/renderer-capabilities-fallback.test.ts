import { describe, expect, test } from "bun:test";

import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_VERBOSE_TTY } from "@lando/sdk/renderer";

import type { RendererIO } from "../../src/cli/renderer/io.ts";
import { makeJsonRenderer, makePlainRenderer, makeVerboseRenderer } from "../../src/cli/renderer/runtime.ts";

const io = (isTTY: boolean): RendererIO => ({
  writeStdout: () => undefined,
  writeStderr: () => undefined,
  isTTY,
});

describe("fallback renderer capabilities", () => {
  test("plain and json are always all-false", () => {
    expect(makePlainRenderer(io(true)).capabilities).toEqual(RENDERER_CAPABILITIES_NONE);
    expect(makePlainRenderer(io(false)).capabilities).toEqual(RENDERER_CAPABILITIES_NONE);
    expect(makeJsonRenderer(io(true)).capabilities).toEqual(RENDERER_CAPABILITIES_NONE);
    expect(makeJsonRenderer(io(false)).capabilities).toEqual(RENDERER_CAPABILITIES_NONE);
  });

  test("verbose is color-only on TTY and all-false otherwise", () => {
    expect(makeVerboseRenderer(io(true)).capabilities).toEqual(RENDERER_CAPABILITIES_VERBOSE_TTY);
    expect(makeVerboseRenderer(io(false)).capabilities).toEqual(RENDERER_CAPABILITIES_NONE);
  });
});
