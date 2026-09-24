import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { cancellableTerminalStdin } from "../../src/cli/commands/terminal-stdin";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

class TerminalInput extends EventEmitter {
  pauses = 0;
  resumes = 0;
  pause(): this {
    this.pauses += 1;
    return this;
  }
  resume(): this {
    this.resumes += 1;
    return this;
  }
}

describe("cancellable terminal stdin", () => {
  test("return releases a pending read without another keypress and removes listeners", async () => {
    const input = new TerminalInput();
    const iterator = cancellableTerminalStdin(input)[Symbol.asyncIterator]();
    const pending = iterator.next();
    expect(input.listenerCount("data")).toBe(1);

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(input.pauses).toBe(1);
    expect(input.resumes).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });

  test("delivers typed bytes and bounds queued input by pausing until read", async () => {
    const input = new TerminalInput();
    const iterator = cancellableTerminalStdin(input)[Symbol.asyncIterator]();

    input.emit("data", bytes("exit\r"));
    expect(input.pauses).toBe(1);
    const result = await iterator.next();
    expect(new TextDecoder().decode(result.value)).toBe("exit\r");
    expect(input.resumes).toBe(1);

    await iterator.return?.();
    expect(input.resumes).toBe(1);
    expect(input.pauses).toBe(2);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("EOF closes a pending read and pauses input", async () => {
    const input = new TerminalInput();
    const iterator = cancellableTerminalStdin(input)[Symbol.asyncIterator]();
    const pending = iterator.next();

    input.emit("end");
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(input.pauses).toBe(1);
    expect(input.listenerCount("data")).toBe(0);
  });
  test("surfaces terminal read errors to the waiting consumer", async () => {
    const input = new TerminalInput();
    const iterator = cancellableTerminalStdin(input)[Symbol.asyncIterator]();
    const pending = iterator.next();

    input.emit("error", new Error("terminal read failed"));
    await expect(pending).rejects.toThrow("terminal read failed");
    expect(input.pauses).toBe(1);
    expect(input.listenerCount("error")).toBe(0);
  });
});
