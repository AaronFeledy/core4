import { describe, expect, test } from "bun:test";

import { createBufferedRendererIO, createStdioRendererIO } from "../../src/cli/renderer/io.ts";

describe("renderer IO output stream seam", () => {
  test("stdio IO exposes process stdout by default", () => {
    const io = createStdioRendererIO();

    expect(io.externalOutputStream).toBe(process.stdout);
  });

  test("stdio IO exposes the injected stdout stream", () => {
    const stdout = process.stderr;

    const io = createStdioRendererIO(stdout);

    expect(io.externalOutputStream).toBe(stdout);
  });

  test("buffered IO omits the external output stream", () => {
    const io = createBufferedRendererIO();

    expect(io.externalOutputStream).toBeUndefined();
  });
});
