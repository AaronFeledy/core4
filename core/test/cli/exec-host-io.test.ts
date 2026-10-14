import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  attachExecHostIo,
  attachedHostTerminal,
  withInheritedStdinRawMode,
} from "../../src/cli/exec-host-io.ts";

describe("attachedHostTerminal", () => {
  test("returns terminal facts only for an attached output TTY", () => {
    // Given
    const output = { isTTY: true, columns: 132, rows: 43 };

    // When
    const terminal = attachedHostTerminal(output, { TERM: "dumb", COLORTERM: "truecolor" });

    // Then
    expect(terminal).toEqual({ term: "dumb", colorterm: "truecolor", columns: 132, rows: 43 });
  });

  test("returns no descriptor for a pipe even when terminal env is present", () => {
    // When
    const terminal = attachedHostTerminal(
      { isTTY: false, columns: 132, rows: 43 },
      { TERM: "xterm-256color", COLORTERM: "truecolor" },
    );

    // Then
    expect(terminal).toBeUndefined();
  });

  test("omits absent, empty, and invalid attached facts without synthesizing values", () => {
    // When
    const terminal = attachedHostTerminal({ isTTY: true, columns: 0 }, { TERM: "", COLORTERM: undefined });

    // Then
    expect(terminal).toEqual({});
  });
});

describe("attachExecHostIo", () => {
  test("wraps inherited stdin so exec cleanup cannot destroy the host stream", () => {
    // Given
    const options = { command: ["cat"], interactive: true } as const;
    let destroyOnReturn: boolean | undefined;
    const stdin = {
      isTTY: true,
      readableFlowing: null,
      resume: () => {},
      pause: () => {},
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
      iterator: (iteratorOptions: { readonly destroyOnReturn: boolean }) => {
        destroyOnReturn = iteratorOptions.destroyOnReturn;
        return stdin[Symbol.asyncIterator]();
      },
    };

    // When
    const attached = attachExecHostIo(options, stdin, { isTTY: false });
    attached.stdinStream?.[Symbol.asyncIterator]();

    // Then
    expect(attached.stdinStream).toBeDefined();
    expect(attached.stdinStream).not.toBe(stdin);
    expect(destroyOnReturn).toBe(false);
  });

  test("forwards piped stdin without a PTY even when stdout is a terminal", async () => {
    // Given
    const options = { command: ["cat"], interactive: true, tty: true } as const;
    const stdin = {
      isTTY: false,
      setRawMode: () => {
        throw new Error("piped input must not enter raw mode");
      },
      readableFlowing: null,
      resume: () => {},
      pause: () => {},
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
      iterator: () => stdin[Symbol.asyncIterator](),
    };

    // When
    const attached = attachExecHostIo(options, stdin, { isTTY: true, columns: 120, rows: 40 });
    await Effect.runPromise(withInheritedStdinRawMode(attached.tty === true, Effect.void, stdin));

    // Then
    expect(attached.tty).toBe(false);
    expect(attached.stdinStream).toBeDefined();
    expect(attached.terminalResize).toBeUndefined();
    expect(attached.env).toBeUndefined();
  });

  test("preserves ssh PTY intent with terminal stdin and piped output", () => {
    // Given
    const options = { command: ["sh", "-l"], tty: true } as const;
    const stdin = {
      isTTY: true,
      readableFlowing: null,
      resume: () => {},
      pause: () => {},
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
      iterator: () => stdin[Symbol.asyncIterator](),
    };

    // When
    const attached = attachExecHostIo(options, stdin, { isTTY: false });

    // Then
    expect(attached.tty).toBe(true);
    expect(attached.hostTerminal).toBeUndefined();
    expect(attached.terminalResize).toBeUndefined();
    expect(attached.env).toMatchObject({ COLUMNS: "80", LINES: "24" });
  });

  test("preserves interactive PTY input and resize when both streams are terminals", () => {
    // Given
    const stdin = {
      isTTY: true,
      readableFlowing: null,
      resume: () => {},
      pause: () => {},
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("hello");
      },
      iterator: () => stdin[Symbol.asyncIterator](),
    };
    // When
    const attached = attachExecHostIo({ command: ["cat"], tty: true, interactive: true }, stdin, {
      isTTY: true,
    });
    // Then
    expect(attached.tty).toBe(true);
    expect(attached.stdinStream).toBeDefined();
    expect(attached.terminalResize).toBeDefined();
  });
});

describe("withInheritedStdinRawMode", () => {
  test("restores raw mode on failure", async () => {
    // Given
    let raw = false;
    const stdin = {
      isTTY: true,
      readableFlowing: null,
      setRawMode: (enabled: boolean) => {
        raw = enabled;
      },
      resume: () => {},
      pause: () => {},
    };
    // When
    const result = await Effect.runPromise(
      withInheritedStdinRawMode(true, Effect.fail("failed"), stdin).pipe(Effect.result),
    );
    // Then
    expect(result._tag).toBe("Failure");
    expect(raw).toBe(false);
  });
  test("restores an initially non-flowing TTY after interactive exec completes", async () => {
    // Given
    let raw = false;
    let flowing: boolean | null = null;
    const stdin = {
      isTTY: true,
      get isRaw() {
        return raw;
      },
      get readableFlowing() {
        return flowing;
      },
      isPaused: () => flowing === false,
      setRawMode: (enabled: boolean) => {
        raw = enabled;
      },
      resume: () => {
        flowing = true;
      },
      pause: () => {
        flowing = false;
      },
    };

    // When
    await Effect.runPromise(withInheritedStdinRawMode(true, Effect.void, stdin));

    // Then
    expect(raw).toBe(false);
    expect(flowing === false).toBe(true);
  });

  test("restores a flowing TTY after a cancellable reader pauses it", async () => {
    let raw = false;
    let flowing: boolean | null = true;
    const stdin = {
      isTTY: true,
      get isRaw() {
        return raw;
      },
      get readableFlowing() {
        return flowing;
      },
      setRawMode: (enabled: boolean) => {
        raw = enabled;
      },
      resume: () => {
        flowing = true;
      },
      pause: () => {
        flowing = false;
      },
    };

    await Effect.runPromise(
      withInheritedStdinRawMode(
        true,
        Effect.sync(() => stdin.pause()),
        stdin,
      ),
    );

    expect(raw).toBe(false);
    expect(flowing).toBe(true);
  });

  test("preserves a TTY that was already flowing before interactive exec", async () => {
    // Given
    let raw = false;
    let flowing: boolean | null = true;
    const stdin = {
      isTTY: true,
      get isRaw() {
        return raw;
      },
      get readableFlowing() {
        return flowing;
      },
      isPaused: () => flowing === false,
      setRawMode: (enabled: boolean) => {
        raw = enabled;
      },
      resume: () => {
        flowing = true;
      },
      pause: () => {
        flowing = false;
      },
    };

    // When
    await Effect.runPromise(withInheritedStdinRawMode(true, Effect.void, stdin));

    // Then
    expect(raw).toBe(false);
    expect(flowing).toBe(true);
  });
});
