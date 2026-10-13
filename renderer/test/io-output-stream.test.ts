import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { createBufferedRendererIO, createStdioRendererIO } from "@lando/renderer/io";

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

const terminalStream = (isTTY: boolean) => {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY,
    columns: 100,
    rows: 24,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, writes };
};

describe("native terminal line endings", () => {
  test("Windows TTY channels return to column zero and preserve split CRLF", () => {
    const stdout = terminalStream(true);
    const stderr = terminalStream(true);
    const io = createStdioRendererIO(stdout.stream, stderr.stream, undefined, { platform: "win32" });

    io.writeStdout("Started\n  app is ready\r\nURLs\r");
    io.writeStderr("Error\n  remediation\n");
    io.writeStdout("");
    io.writeStdout("\n  https://app.test\n");
    io.writeStderr("progress\r");

    expect(stdout.writes.join("")).toBe("Started\r\n  app is ready\r\nURLs\r\n  https://app.test\r\n");
    expect(stderr.writes.join("")).toBe("Error\r\n  remediation\r\nprogress\r");
    expect(io.externalOutputStream).toBe(stdout.stream);
  });

  test.each([
    ["linux", true, true],
    ["darwin", true, true],
    ["win32", false, true],
    ["win32", true, false],
  ] as const)("preserves bytes on %s with TTY=%s textNewlines=%s", (platform, isTTY, terminalNewlines) => {
    const stdout = terminalStream(isTTY);
    const stderr = terminalStream(isTTY);
    const io = createStdioRendererIO(stdout.stream, stderr.stream, undefined, { platform, terminalNewlines });
    const chunks = ["first\nsecond\r\nthird\r", "", "\nlast"];
    for (const chunk of chunks) {
      io.writeStdout(chunk);
      io.writeStderr(chunk);
    }
    expect(stdout.writes).toEqual(chunks);
    expect(stderr.writes).toEqual(chunks);
  });

  test("normalizes stderr independently when only stderr is a terminal", () => {
    const stdout = terminalStream(false);
    const stderr = terminalStream(true);
    const io = createStdioRendererIO(stdout.stream, stderr.stream, undefined, { platform: "win32" });
    io.writeStdout("machine\n");
    io.writeStderr("diagnostic\n");
    expect(stdout.writes).toEqual(["machine\n"]);
    expect(stderr.writes).toEqual(["diagnostic\r\n"]);
  });
});
