import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, spyOn, test } from "bun:test";
import { Cause, Effect, Fiber, Stream } from "effect";

import { VerifiedStreamError, persistVerifiedStream } from "@lando/sdk/verified-stream";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

const withDestination = async (run: (target: string, temporary: string) => Promise<void>): Promise<void> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "lando-verified-writes-"));
  const target = join(directory, "artifact.bin");
  try {
    await fs.writeFile(target, "original");
    await run(target, `${target}.tmp-writes`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

describe("persistVerifiedStream writes", () => {
  test("drains real partial writes across chunks and nonzero-offset views", async () => {
    await withDestination(async (target, temporary) => {
      const first = bytes("LEFTabcdeRIGHT");
      const second = bytes("xxfghijyy");
      const chunks = [first.subarray(4, 9), second.subarray(2, 7)];
      const writes: Array<string> = [];
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (path !== temporary) return handle;
        const write = handle.write.bind(handle);
        handle.write = ((buffer: Uint8Array, ...args: ReadonlyArray<unknown>) => {
          expect(args).toEqual([]);
          writes.push(new TextDecoder().decode(buffer));
          if (writes.length > 10) return Promise.reject(new Error("partial write did not advance"));
          return write(buffer.subarray(0, 2));
        }) as typeof handle.write;
        return handle;
      });
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            persistVerifiedStream({
              body: Stream.fromIterable(chunks),
              destinationPath: target,
              randomId: () => "writes",
              expectedSha256: digest("abcdefghij"),
              expectedSizeBytes: 10,
            }),
          ).pipe(Effect.timeout("1 second")),
        );
        expect(result).toEqual({ sha256: digest("abcdefghij"), sizeBytes: 10 });
        expect(await fs.readFile(target, "utf8")).toBe("abcdefghij");
        expect(writes).toEqual(["abcde", "cde", "e", "fghij", "hij", "j"]);
        expect(first).toEqual(bytes("LEFTabcdeRIGHT"));
        expect(second).toEqual(bytes("xxfghijyy"));
        expect(await fs.readdir(join(target, ".."))).toEqual(["artifact.bin"]);
      } finally {
        open.mockRestore();
      }
    });
  });

  test("skips interspersed empty chunks while native full writes preserve order", async () => {
    await withDestination(async (target, temporary) => {
      const lengths: Array<number> = [];
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (path !== temporary) return handle;
        const write = handle.write.bind(handle);
        handle.write = ((buffer: Uint8Array) => {
          lengths.push(buffer.length);
          return write(buffer);
        }) as typeof handle.write;
        return handle;
      });
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            persistVerifiedStream({
              body: Stream.make(bytes(""), bytes("abc"), bytes(""), bytes("def"), bytes("")),
              destinationPath: target,
              randomId: () => "writes",
              expectedSha256: digest("abcdef"),
              expectedSizeBytes: 6,
            }),
          ),
        );
        expect(result).toEqual({ sha256: digest("abcdef"), sizeBytes: 6 });
        expect(await fs.readFile(target, "utf8")).toBe("abcdef");
        expect(lengths).toEqual([3, 3]);
      } finally {
        open.mockRestore();
      }
    });
  });

  for (const bytesWritten of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    5,
  ]) {
    test(`rejects invalid write progress ${bytesWritten} without retrying`, async () => {
      await withDestination(async (target, temporary) => {
        let calls = 0;
        const originalOpen = fs.open;
        const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
          const handle = await originalOpen(path, flags, mode);
          if (path !== temporary) return handle;
          handle.write = ((buffer: Uint8Array) => {
            calls += 1;
            if (calls > 4) return Promise.reject(new Error("invalid write progress retried"));
            return Promise.resolve({ bytesWritten, buffer });
          }) as typeof handle.write;
          return handle;
        });
        try {
          const error = await Effect.runPromise(
            Effect.scoped(
              persistVerifiedStream({
                body: Stream.make(bytes("abcd")),
                destinationPath: target,
                randomId: () => "writes",
                expectedSha256: digest("abcd"),
                expectedSizeBytes: 4,
              }),
            ).pipe(Effect.flip, Effect.timeout("1 second")),
          );
          expect(error).toBeInstanceOf(VerifiedStreamError);
          expect(error.reason).toBe("persist");
          expect(error.message).toBe("Failed to write artifact bytes.");
          expect(calls).toBe(1);
          expect(await fs.readFile(target, "utf8")).toBe("original");
          expect(await fs.readdir(join(target, ".."))).toEqual(["artifact.bin"]);
        } finally {
          open.mockRestore();
        }
      });
    });
  }

  for (const failure of ["zero", "error"] as const) {
    test(`partial write followed by ${failure} preserves the destination and removes the temporary file`, async () => {
      await withDestination(async (target, temporary) => {
        let calls = 0;
        const cause = new Error("write failed");
        const originalOpen = fs.open;
        const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
          const handle = await originalOpen(path, flags, mode);
          if (path !== temporary) return handle;
          const write = handle.write.bind(handle);
          handle.write = ((buffer: Uint8Array) => {
            calls += 1;
            if (calls === 1) return write(buffer.subarray(0, 2));
            if (calls > 4) return Promise.reject(new Error("partial write did not fail"));
            return failure === "zero" ? Promise.resolve({ bytesWritten: 0, buffer }) : Promise.reject(cause);
          }) as typeof handle.write;
          return handle;
        });
        try {
          const error = await Effect.runPromise(
            Effect.scoped(
              persistVerifiedStream({
                body: Stream.make(bytes("abcdef")),
                destinationPath: target,
                randomId: () => "writes",
                expectedSha256: digest("abcdef"),
                expectedSizeBytes: 6,
              }),
            ).pipe(Effect.flip, Effect.timeout("1 second")),
          );
          expect(error).toBeInstanceOf(VerifiedStreamError);
          expect(error.reason).toBe("persist");
          if (failure === "error") expect(error.cause).toBe(cause);
          expect(calls).toBe(2);
          expect(await fs.readFile(target, "utf8")).toBe("original");
          expect(await fs.readdir(join(target, ".."))).toEqual(["artifact.bin"]);
        } finally {
          open.mockRestore();
        }
      });
    });
  }

  for (const reason of ["checksum", "size"] as const) {
    test(`${reason} failure after drained partial writes still cleans up`, async () => {
      await withDestination(async (target, temporary) => {
        let calls = 0;
        const originalOpen = fs.open;
        const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
          const handle = await originalOpen(path, flags, mode);
          if (path !== temporary) return handle;
          const write = handle.write.bind(handle);
          handle.write = ((buffer: Uint8Array) => {
            calls += 1;
            if (calls > 6) return Promise.reject(new Error("partial write did not advance"));
            return write(buffer.subarray(0, 2));
          }) as typeof handle.write;
          return handle;
        });
        try {
          const error = await Effect.runPromise(
            Effect.scoped(
              persistVerifiedStream({
                body: Stream.make(bytes("abcdef")),
                destinationPath: target,
                randomId: () => "writes",
                expectedSha256: reason === "checksum" ? digest("wrong") : digest("abcdef"),
                expectedSizeBytes: reason === "size" ? 7 : 6,
              }),
            ).pipe(Effect.flip, Effect.timeout("1 second")),
          );
          expect(error).toBeInstanceOf(VerifiedStreamError);
          expect(error.reason).toBe(reason);
          expect(calls).toBe(3);
          expect(await fs.readFile(target, "utf8")).toBe("original");
          expect(await fs.readdir(join(target, ".."))).toEqual(["artifact.bin"]);
        } finally {
          open.mockRestore();
        }
      });
    });
  }

  test("size overflow performs zero writes and preserves the destination", async () => {
    await withDestination(async (target, temporary) => {
      let calls = 0;
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (path !== temporary) return handle;
        const write = handle.write.bind(handle);
        handle.write = ((buffer: Uint8Array) => {
          calls += 1;
          return write(buffer);
        }) as typeof handle.write;
        return handle;
      });
      try {
        const error = await Effect.runPromise(
          Effect.scoped(
            persistVerifiedStream({
              body: Stream.make(bytes("oversized")),
              destinationPath: target,
              randomId: () => "writes",
              expectedSizeBytes: 1,
            }),
          ).pipe(Effect.flip),
        );
        expect(error.reason).toBe("size");
        expect(calls).toBe(0);
        expect(await fs.readFile(target, "utf8")).toBe("original");
        expect(await fs.readdir(join(target, ".."))).toEqual(["artifact.bin"]);
      } finally {
        open.mockRestore();
      }
    });
  });

  test("interruption after a real partial write closes and removes the file without a background write", async () => {
    await withDestination(async (target, temporary) => {
      let release!: () => void;
      let started!: () => void;
      let settled!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const returned = new Promise<void>((resolve) => {
        settled = resolve;
      });
      let calls = 0;
      let closes = 0;
      let finalized = 0;
      let acquired: Awaited<ReturnType<typeof fs.open>> | undefined;
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (path !== temporary) return handle;
        acquired = handle;
        const write = handle.write.bind(handle);
        handle.write = (async (buffer: Uint8Array) => {
          calls += 1;
          if (calls > 4) throw new Error("partial write did not stop");
          const result = await write(buffer.subarray(0, 2));
          started();
          await paused;
          settled();
          return result;
        }) as typeof handle.write;
        const close = handle.close.bind(handle);
        handle.close = () => {
          closes += 1;
          return close();
        };
        return handle;
      });
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const body = Stream.make(bytes("abcdef")).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            );
            const fiber = yield* Effect.forkChild(
              Effect.scoped(
                persistVerifiedStream({
                  body,
                  destinationPath: target,
                  randomId: () => "writes",
                  expectedSha256: digest("abcdef"),
                  expectedSizeBytes: 6,
                }),
              ),
            );
            yield* Effect.promise(() => writing);
            expect(yield* Effect.promise(() => fs.readFile(temporary, "utf8"))).toBe("ab");
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            expect(exit._tag).toBe("Failure");
            if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            expect(closes).toBe(1);
            expect(finalized).toBe(1);
            release();
            yield* Effect.promise(() => returned);
            yield* Effect.yieldNow;
            expect(calls).toBe(1);
          }).pipe(Effect.timeout("1 second")),
        );
        await expect(acquired?.stat()).rejects.toThrow();
        expect(await fs.readFile(target, "utf8")).toBe("original");
        expect(await fs.readdir(join(target, ".."))).toEqual(["artifact.bin"]);
      } finally {
        release();
        await acquired?.close().catch(() => undefined);
        open.mockRestore();
      }
    });
  });
});
