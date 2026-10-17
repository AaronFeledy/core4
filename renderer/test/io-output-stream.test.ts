import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBufferedRendererIO,
  createStdioRendererIO,
  withStdioTerminalNewlines,
} from "@lando/renderer/io";

// The test runner's stdout is a pipe, which keeps narration in line mode.
const stdoutOnFd = (fd: number) =>
  Object.assign(new Socket(), {
    fd,
    isTTY: false,
    columns: 80,
    rows: 24,
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    getWindowSize: (): [number, number] => [80, 24],
    getColorDepth: () => 1,
    hasColors: () => false,
  });
const deviceStdout = () => stdoutOnFd(openSync(devNull, "w"));

describe("renderer IO output stream seam", () => {
  test("stdio IO exposes process stderr by default", () => {
    const io = createStdioRendererIO(deviceStdout());

    expect(io.externalOutputStream?.isTTY).toBe(process.stderr.isTTY);
  });

  test("stdio IO exposes the injected narration stream", () => {
    const stderr = process.stdout;

    const io = createStdioRendererIO(process.stdout, stderr);

    expect(io.externalOutputStream?.isTTY).toBe(stderr.isTTY);
  });

  test.skipIf(process.platform === "win32")(
    "a pipe on stdout keeps narration append-only while a file keeps the live region",
    () => {
      // Given
      const dir = mkdtempSync(join(tmpdir(), "lando-stdout-kind-"));
      const fifo = join(dir, "pipe");
      Bun.spawnSync(["mkfifo", fifo]);
      const pipeFd = openSync(fifo, "r+");
      const fileFd = openSync(join(dir, "file"), "w");
      try {
        // When
        const piped = createStdioRendererIO(stdoutOnFd(pipeFd), process.stderr);
        const redirected = createStdioRendererIO(stdoutOnFd(fileFd), process.stderr);

        // Then
        expect(piped.externalOutputStream).toBeUndefined();
        expect(piped.isTTY).toBe(process.stderr.isTTY === true);
        expect(redirected.externalOutputStream).toBeDefined();
      } finally {
        closeSync(pipeFd);
        closeSync(fileFd);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("buffered IO omits the external output stream", () => {
    const io = createBufferedRendererIO();

    expect(io.externalOutputStream).toBeUndefined();
  });

  test("forwards native stderr resize signals and unregisters the listener", () => {
    const io = createStdioRendererIO(deviceStdout());
    let resized = 0;
    const listener = () => {
      resized += 1;
    };
    const before = process.listenerCount("SIGWINCH");
    io.externalOutputStream?.on("resize", listener);
    try {
      process.emit("SIGWINCH");
      expect(resized).toBe(1);
    } finally {
      io.externalOutputStream?.off("resize", listener);
    }
    expect(process.listenerCount("SIGWINCH")).toBe(before);
  });
});

const terminalStream = (isTTY: boolean) => {
  const writes: (string | Uint8Array)[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY,
    columns: 100,
    rows: 24,
    write: (chunk: string | Uint8Array) => {
      writes.push(chunk);
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, writes };
};

describe("native terminal line endings", () => {
  test("Windows raw byte writers bypass text translation and survive machine IO selection", () => {
    const stdout = terminalStream(true);
    const stderr = terminalStream(true);
    const io = createStdioRendererIO(stdout.stream, stderr.stream, undefined, { platform: "win32" });
    const bytes = new Uint8Array([0xff, 0x0a, 0x0d, 0x0a, 0x00]);

    io.writeStdoutBytes(bytes);
    io.writeStderrBytes(bytes);
    const machineIO = withStdioTerminalNewlines(io, false);
    machineIO.writeStdoutBytes?.(bytes);
    machineIO.writeStderrBytes?.(bytes);

    expect(stdout.writes).toEqual([bytes, bytes]);
    expect(stderr.writes).toEqual([bytes, bytes]);
  });

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
    expect(io.externalOutputStream?.columns).toBe(stderr.stream.columns);
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
