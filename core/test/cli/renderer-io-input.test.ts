import { describe, expect, test } from "bun:test";

import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

describe("createBufferedRendererIO — input seam", () => {
  test("injected keys reach a subscribed onKey callback", () => {
    const io = createBufferedRendererIO();
    const received: string[] = [];
    io.subscribeInput((raw) => received.push(raw));
    io.injectKey("\r");
    io.injectKey("\x1b");
    expect(received).toEqual(["\r", "\x1b"]);
  });

  test("unsubscribe stops further delivery", () => {
    const io = createBufferedRendererIO();
    const received: string[] = [];
    const unsubscribe = io.subscribeInput((raw) => received.push(raw));
    io.injectKey("a");
    unsubscribe();
    io.injectKey("b");
    expect(received).toEqual(["a"]);
  });

  test("terminalRows is readable and configurable", () => {
    const io = createBufferedRendererIO({ terminalRows: 24 });
    expect(io.terminalRows).toBe(24);
  });
});
