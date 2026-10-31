import { describe, expect, test } from "bun:test";

import { RENDERER_CAPABILITIES_NONE, RENDERER_CAPABILITIES_VERBOSE_TTY } from "@lando/sdk/renderer";

import type { RendererIO } from "@lando/renderer/io";
import { makeJsonRenderer, makePlainRenderer, makeVerboseRenderer } from "@lando/renderer/runtime";

const io = (isTTY: boolean): RendererIO => ({
  writeStdout: () => undefined,
  writeStderr: () => undefined,
  isTTY,
});

describe("fallback renderer capabilities", () => {
  test("verbose suppresses color when TTY IO opts out", () => {
    // Given
    const terminal = { ...io(true), noColor: true };
    // When
    const renderer = makeVerboseRenderer(terminal);
    // Then
    expect(renderer.capabilities).toEqual(RENDERER_CAPABILITIES_NONE);
  });
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
