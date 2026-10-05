import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { cancellableTerminalStdin } from "../../src/cli/commands/terminal-stdin";
import { attachToolingHostIo } from "../../src/cli/exec-host-io";

class TerminalInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  readableFlowing = false;
  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
  }
  resume() {
    this.readableFlowing = true;
  }
  pause() {
    this.readableFlowing = false;
  }
  [Symbol.asyncIterator]() {
    this.resume();
    return cancellableTerminalStdin(this)[Symbol.asyncIterator]();
  }
  iterator(_options: { readonly destroyOnReturn: boolean }) {
    return this[Symbol.asyncIterator]();
  }
}

describe("attachToolingHostIo", () => {
  test.each([
    [true, true, true],
    [true, false, true],
    [true, true, false],
    [false, true, true],
  ])("gates keyboard input with enabled=%s stdinTTY=%s stdoutTTY=%s", (enabled, stdinTTY, stdoutTTY) => {
    // Given
    const stdin = Object.assign(new PassThrough(), { isTTY: stdinTTY });
    // When
    const attached = attachToolingHostIo(enabled, stdin, { isTTY: stdoutTTY, columns: 140, rows: 35 });
    // Then
    expect(attached.tty).toBe(enabled && stdoutTTY);
    expect(attached.stdinStream !== undefined).toBe(enabled && stdinTTY && stdoutTTY);
    expect(attached.terminalResize !== undefined).toBe(enabled && stdinTTY && stdoutTTY);
    stdin.destroy();
  });

  test("successive readers receive input with cooked mode between readers", async () => {
    // Given
    const stdin = new TerminalInput();
    const attached = attachToolingHostIo(true, stdin, { isTTY: true });
    const received: string[] = [];
    const modes: boolean[] = [stdin.isRaw];
    // When
    for (const text of ["first", "second"]) {
      const iterator = attached.stdinStream?.[Symbol.asyncIterator]();
      modes.push(stdin.isRaw);
      const pending = iterator?.next();
      expect(stdin.readableFlowing).toBe(true);
      stdin.emit("data", new TextEncoder().encode(text));
      const chunk = await pending;
      if (chunk !== undefined && !chunk.done) received.push(new TextDecoder().decode(chunk.value));
      const closing = iterator?.return?.();
      modes.push(stdin.isRaw);
      await closing;
    }
    // Then
    expect(received).toEqual(["first", "second"]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(modes).toEqual([false, true, false, true, false]);
  });

  test.each(["completion", "error", "throw"] as const)(
    "restores the prior terminal state on reader %s",
    async (ending) => {
      // Given
      const stdin = new TerminalInput();
      const attached = attachToolingHostIo(true, stdin, { isTTY: true });
      const reader = attached.stdinStream?.[Symbol.asyncIterator]();
      const error = new Error("terminal reader failed");
      expect(stdin.isRaw).toBe(true);
      // When
      switch (ending) {
        case "completion": {
          const pending = reader?.next();
          stdin.emit("end");
          await expect(pending).resolves.toMatchObject({ done: true });
          break;
        }
        case "error": {
          const pending = reader?.next();
          stdin.emit("error", error);
          await expect(pending).rejects.toBe(error);
          break;
        }
        case "throw":
          await expect(reader?.throw?.(error)).rejects.toBe(error);
          break;
        default:
          return ending satisfies never;
      }
      // Then
      expect(stdin.isRaw).toBe(false);
      expect(stdin.readableFlowing).toBe(false);
      expect(stdin.listenerCount("data")).toBe(0);
    },
  );
});
