import { expect, test } from "bun:test";
import { constants, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darwinIgnoresInterrupt, fileStatusFlags } from "../../src/runtime/libc.ts";

test.skipIf(process.platform === "win32")("file-status flags round-trip O_NONBLOCK on an owned FIFO", () => {
  // Given a private FIFO writer and an independent three-argument F_GETFL oracle.
  const dir = mkdtempSync(join(tmpdir(), "lando-libc-"));
  try {
    const path = join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const read = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const write = openSync(path, constants.O_WRONLY | constants.O_APPEND);
      try {
        const { dlopen }: typeof import("bun:ffi") = require("bun:ffi");
        const oracle = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
          fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
        });
        try {
          const flags = fileStatusFlags();
          if (flags === undefined) throw new Error("Expected native file-status bindings");
          const original = oracle.symbols.fcntl(write, 3, 0);
          expect(original).toBeGreaterThanOrEqual(0);
          expect(flags.get(write)).toBe(original);
          // When the shared binding sets and then clears O_NONBLOCK.
          expect(flags.set(write, original | flags.nonblock)).toBe(0);
          // Then the independent oracle observes each transition without losing O_APPEND.
          expect(oracle.symbols.fcntl(write, 3, 0)).toBe(original | flags.nonblock);
          expect(flags.set(write, original & ~flags.nonblock)).toBe(0);
          expect(oracle.symbols.fcntl(write, 3, 0)).toBe(original & ~flags.nonblock);
        } finally {
          oracle.close();
        }
      } finally {
        closeSync(write);
      }
    } finally {
      closeSync(read);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("Darwin interrupt disposition query returns a boolean", () => {
  // Given the current process's inherited signal disposition.
  // When the shared libc binding queries it without changing it.
  const ignored = darwinIgnoresInterrupt();
  // Then hosts can safely use the result to choose their interrupt listeners.
  expect(typeof ignored).toBe("boolean");
});
