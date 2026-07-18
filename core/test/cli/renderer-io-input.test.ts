import { describe, expect, test } from "bun:test";

import { createBufferedRendererIO, createStdioRendererIO } from "../../src/cli/renderer/io.ts";

const makeStdin = (initiallyPaused: boolean, initiallyRaw: boolean) => {
  let paused = initiallyPaused;
  let raw = initiallyRaw;
  const listeners = new Set<(chunk: Buffer | string) => void>();
  return {
    isTTY: true,
    get isRaw() {
      return raw;
    },
    isPaused: () => paused,
    setRawMode: (nextRaw: boolean) => {
      raw = nextRaw;
    },
    resume: () => {
      paused = false;
    },
    pause: () => {
      paused = true;
    },
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      listeners.add(listener);
    },
    off: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      listeners.delete(listener);
    },
    state: () => ({ paused, raw }),
  };
};

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

describe("createStdioRendererIO — input state", () => {
  test("unsubscribe restores initially paused stdin and its prior raw mode", () => {
    const stdin = makeStdin(true, false);
    const io = createStdioRendererIO(process.stdout, process.stderr, stdin);

    const unsubscribe = io.subscribeInput?.(() => {});
    expect(stdin.state()).toEqual({ paused: false, raw: true });
    unsubscribe?.();

    expect(stdin.state()).toEqual({ paused: true, raw: false });
  });

  test("unsubscribe restores initially flowing stdin and its prior raw mode", () => {
    const stdin = makeStdin(false, true);
    const io = createStdioRendererIO(process.stdout, process.stderr, stdin);

    const unsubscribe = io.subscribeInput?.(() => {});
    unsubscribe?.();

    expect(stdin.state()).toEqual({ paused: false, raw: true });
  });
});
