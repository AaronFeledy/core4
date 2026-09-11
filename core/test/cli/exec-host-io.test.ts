import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { attachExecHostIo, withInheritedStdinRawMode } from "../../src/cli/exec-host-io.ts";

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
    const attached = attachExecHostIo(options, stdin);
    attached.stdinStream?.[Symbol.asyncIterator]();

    // Then
    expect(attached.stdinStream).toBeDefined();
    expect(attached.stdinStream).not.toBe(stdin);
    expect(destroyOnReturn).toBe(false);
  });
});

describe("withInheritedStdinRawMode", () => {
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
