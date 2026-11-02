import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, spyOn, test } from "bun:test";
import { Cause, Effect, Fiber } from "effect";

import { tryCacheHit } from "../src/downloader-cache.ts";

const digest = (content: Uint8Array | string): string => createHash("sha256").update(content).digest("hex");
const request = (path: string, content: Uint8Array | string, expectedSizeBytes?: number) => ({
  url: "https://example.test/artifact.bin",
  destination: { kind: "file" as const, directory: path, filename: "artifact.bin" },
  expectedSha256: digest(content),
  ...(expectedSizeBytes === undefined ? {} : { expectedSizeBytes }),
});

const withCandidate = async (run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "lando-cache-safety-"));
  try {
    await run(join(directory, "artifact.bin"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

const within = async <A>(promise: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cache operation did not settle")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe("Downloader cache acquisition", () => {
  test("verifies stable empty and multi-chunk files with finite positional reads and local close", async () => {
    await withCandidate(async (path) => {
      for (const content of [new Uint8Array(), new Uint8Array(3 * 64 * 1024 + 5).fill(97)]) {
        await fs.writeFile(path, content);
        const reads: Array<{ length: number; position: number }> = [];
        let closes = 0;
        const originalOpen = fs.open;
        const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
          const handle = await originalOpen(file, flags, mode);
          if (file !== path) return handle;
          const read = handle.read.bind(handle);
          handle.read = ((buffer: Uint8Array, offset: number, length: number, position: number) => {
            reads.push({ length, position });
            return read(buffer, offset, length, position);
          }) as typeof handle.read;
          const close = handle.close.bind(handle);
          handle.close = () => {
            closes += 1;
            return close();
          };
          return handle;
        });
        try {
          const result = await Effect.runPromise(tryCacheHit(request(path, content, content.length), path));
          expect(result?.fromCache).toBe(true);
          expect(result?.sizeBytes).toBe(content.length);
          expect(closes).toBe(1);
          expect(reads.length).toBeGreaterThan(0);
          expect(reads.every(({ length }) => length > 0 && length <= 64 * 1024)).toBe(true);
          expect(reads.at(-1)).toEqual({ length: 1, position: content.length });
          expect(reads.reduce((total, { length }) => total + length, 0)).toBe(content.length + 1);
        } finally {
          open.mockRestore();
        }
      }
    });
  });

  test("rejects a known size mismatch before opening the candidate", async () => {
    await withCandidate(async (path) => {
      await fs.writeFile(path, "oversized");
      const open = spyOn(fs, "open");
      try {
        expect(await Effect.runPromise(tryCacheHit(request(path, "oversized", 1), path))).toBeUndefined();
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    });
  });

  test("missing, directory, and checksum-mismatched candidates are misses", async () => {
    await withCandidate(async (path) => {
      expect(await Effect.runPromise(tryCacheHit(request(path, ""), path))).toBeUndefined();
      await fs.mkdir(path);
      expect(await Effect.runPromise(tryCacheHit(request(path, ""), path))).toBeUndefined();
      await fs.rmdir(path);
      await fs.writeFile(path, "stale");
      expect(await Effect.runPromise(tryCacheHit(request(path, "fresh"), path))).toBeUndefined();
    });
  });

  test.skipIf(process.platform === "win32")("rejects a real FIFO before acquiring a reader", async () => {
    await withCandidate(async (path) => {
      expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
      // Guards make a regression fail promptly instead of blocking on a FIFO
      // without a writer, including the previous createReadStream implementation.
      const readStream = spyOn(nodeFs, "createReadStream").mockImplementation(() => {
        throw new Error("FIFO reader must not be acquired");
      });
      const open = spyOn(fs, "open").mockRejectedValue(new Error("FIFO must not be opened"));
      try {
        expect(await within(Effect.runPromise(tryCacheHit(request(path, ""), path)))).toBeUndefined();
        expect(readStream).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        readStream.mockRestore();
        open.mockRestore();
      }
    });
  });

  test.skipIf(process.platform !== "linux")(
    "rejects bytes from a size-zero regular-looking pseudo-file",
    async () => {
      const path = "/proc/version";
      expect((await fs.lstat(path)).isFile()).toBe(true);
      expect((await fs.lstat(path)).size).toBe(0);
      expect(await Effect.runPromise(tryCacheHit(request(path, "", 0), path))).toBeUndefined();
    },
  );

  for (const mutation of ["grow", "truncate", "replace", "rewrite"] as const) {
    test(`rejects a candidate that changes after its first read: ${mutation}`, async () => {
      await withCandidate(async (path) => {
        const content = new Uint8Array(128 * 1024).fill(97);
        await fs.writeFile(path, content);
        const originalOpen = fs.open;
        let mutated = false;
        let closes = 0;
        let readCalls = 0;
        const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
          const handle = await originalOpen(file, flags, mode);
          if (file !== path) return handle;
          const read = handle.read.bind(handle);
          handle.read = (async (...args: Parameters<typeof handle.read>) => {
            readCalls += 1;
            const result = await read(...args);
            if (!mutated) {
              mutated = true;
              if (mutation === "grow") await fs.appendFile(path, "extra");
              if (mutation === "truncate") await fs.truncate(path, 0);
              if (mutation === "replace") {
                await fs.rename(path, `${path}.old`);
                await fs.writeFile(path, content);
              }
              if (mutation === "rewrite") {
                // The hashed prefix stays identical; ctime/mtime detect the write.
                await fs.writeFile(path, content);
                await fs.utimes(path, 1, 1);
              }
            }
            return result;
          }) as typeof handle.read;
          const close = handle.close.bind(handle);
          handle.close = () => {
            closes += 1;
            return close();
          };
          return handle;
        });
        try {
          expect(await Effect.runPromise(tryCacheHit(request(path, content), path))).toBeUndefined();
          expect(mutated).toBe(true);
          expect(readCalls).toBeLessThanOrEqual(3);
          expect(closes).toBe(1);
        } finally {
          open.mockRestore();
        }
      });
    });
  }

  test("rejects a same-byte replacement between path admission and descriptor acquisition", async () => {
    await withCandidate(async (path) => {
      await fs.writeFile(path, "verified");
      const originalOpen = fs.open;
      let closes = 0;
      const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (file === path) {
          await fs.rename(path, `${path}.old`);
          await fs.writeFile(path, "verified");
        }
        const handle = await originalOpen(file, flags, mode);
        const close = handle.close.bind(handle);
        handle.close = () => {
          closes += 1;
          return close();
        };
        return handle;
      });
      try {
        expect(await Effect.runPromise(tryCacheHit(request(path, "verified"), path))).toBeUndefined();
        expect(closes).toBe(1);
      } finally {
        open.mockRestore();
      }
    });
  });

  test.skipIf(process.platform === "win32")(
    "a FIFO substituted during acquisition cannot block open",
    async () => {
      await withCandidate(async (path) => {
        await fs.writeFile(path, "verified");
        const originalOpen = fs.open;
        let closes = 0;
        let flagsSeen: string | number | undefined;
        const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
          if (file === path) {
            flagsSeen = flags;
            await fs.unlink(path);
            expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
            // Fail safely if nonblocking admission regresses.
            if (typeof flags !== "number" || (flags & nodeFs.constants.O_NONBLOCK) === 0) {
              throw new Error("FIFO open must be nonblocking");
            }
          }
          const handle = await originalOpen(file, flags, mode);
          const close = handle.close.bind(handle);
          handle.close = () => {
            closes += 1;
            return close();
          };
          return handle;
        });
        try {
          expect(
            await within(Effect.runPromise(tryCacheHit(request(path, "verified"), path))),
          ).toBeUndefined();
          expect(typeof flagsSeen).toBe("number");
          expect((flagsSeen as number) & nodeFs.constants.O_NOFOLLOW).toBe(nodeFs.constants.O_NOFOLLOW);
          expect(closes).toBe(1);
        } finally {
          open.mockRestore();
        }
      });
    },
  );

  test("read failure is a miss and closes the descriptor before returning", async () => {
    await withCandidate(async (path) => {
      await fs.writeFile(path, "verified");
      const originalOpen = fs.open;
      let closes = 0;
      const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        handle.read = () => Promise.reject(new Error("read failed"));
        const close = handle.close.bind(handle);
        handle.close = () => {
          closes += 1;
          return close();
        };
        return handle;
      });
      try {
        expect(await Effect.runPromise(tryCacheHit(request(path, "verified"), path))).toBeUndefined();
        expect(closes).toBe(1);
      } finally {
        open.mockRestore();
      }
    });
  });

  test("interruption closes the acquired descriptor and schedules no further reads", async () => {
    await withCandidate(async (path) => {
      const content = new Uint8Array(128 * 1024).fill(97);
      await fs.writeFile(path, content);
      let release!: () => void;
      let started!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const originalOpen = fs.open;
      let closes = 0;
      let reads = 0;
      const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        const read = handle.read.bind(handle);
        handle.read = (async (...args: Parameters<typeof handle.read>) => {
          reads += 1;
          const result = await read(...args);
          started();
          await paused;
          return result;
        }) as typeof handle.read;
        const close = handle.close.bind(handle);
        handle.close = () => {
          closes += 1;
          return close();
        };
        return handle;
      });
      const fiber = Effect.runFork(tryCacheHit(request(path, content), path));
      try {
        await within(reading);
        await within(Effect.runPromise(Fiber.interrupt(fiber)));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(closes).toBe(1);
        release();
        await Promise.resolve();
        expect(reads).toBe(1);
      } finally {
        release();
        await Effect.runPromise(Fiber.interrupt(fiber));
        open.mockRestore();
      }
    });
  });

  test("interruption during acquisition closes a handle returned by a late successful open", async () => {
    await withCandidate(async (path) => {
      await fs.writeFile(path, "verified");
      let release!: () => void;
      let started!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opening = new Promise<void>((resolve) => {
        started = resolve;
      });
      const originalOpen = fs.open;
      let acquired: Awaited<ReturnType<typeof fs.open>> | undefined;
      let closes = 0;
      const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        acquired = handle;
        const close = handle.close.bind(handle);
        handle.close = () => {
          closes += 1;
          return close();
        };
        started();
        await paused;
        return handle;
      });
      const fiber = Effect.runFork(tryCacheHit(request(path, "verified"), path));
      try {
        await within(opening);
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        await Promise.resolve();
        expect(closes).toBe(0);
        release();
        await within(interrupted);
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(closes).toBe(1);
        await expect(acquired?.stat()).rejects.toThrow();
      } finally {
        release();
        await Effect.runPromise(Fiber.interrupt(fiber));
        await acquired?.close().catch(() => undefined);
        open.mockRestore();
      }
    });
  });
});
