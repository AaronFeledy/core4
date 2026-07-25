import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Stream } from "effect";

import { FileNotFoundError } from "@lando/core/errors";
import { FileSystem } from "@lando/core/services";
import { FileSystemLive, writeAtomicFile } from "../../src/services/file-system.ts";

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-file-system-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("FileSystemLive", () => {
  test("writes, reads, stats, lists, and removes files", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "nested", "hello.txt");

      const result = await Effect.runPromise(
        Effect.flatMap(FileSystem, (fileSystem) =>
          Effect.gen(function* () {
            yield* fileSystem.mkdir(join(dir, "nested"));
            yield* fileSystem.write(filePath, "hello");
            const text = yield* fileSystem.readText(filePath);
            const chunks = yield* fileSystem.read(filePath).pipe(Stream.runCollect);
            const exists = yield* fileSystem.exists(filePath);
            const stats = yield* fileSystem.stat(filePath);
            const entries = yield* fileSystem.readDir(join(dir, "nested"));
            yield* fileSystem.remove(filePath);
            const existsAfterRemove = yield* fileSystem.exists(filePath);

            return { chunks, entries, exists, existsAfterRemove, stats, text };
          }),
        ).pipe(Effect.provide(FileSystemLive)),
      );

      expect(result.text).toBe("hello");
      expect(
        new TextDecoder().decode(Uint8Array.from(Array.from(result.chunks).flatMap((chunk) => [...chunk]))),
      ).toBe("hello");
      expect(result.exists).toBe(true);
      expect(result.stats).toMatchObject({ size: 5, isFile: true, isDirectory: false });
      expect(result.entries).toEqual(["hello.txt"]);
      expect(result.existsAfterRemove).toBe(false);
    });
  });

  test("fails missing reads with FileNotFoundError carrying the path", async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, "missing.txt");
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(FileSystem, (fileSystem) => fileSystem.readText(missing)).pipe(
          Effect.provide(FileSystemLive),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(FileNotFoundError);
          expect(failure.value.path).toBe(missing);
        }
      }
    });
  });

  test("supports atomic writes with temp cleanup", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "atomic.txt");

      const result = await Effect.runPromise(
        Effect.flatMap(FileSystem, (fileSystem) =>
          Effect.gen(function* () {
            yield* fileSystem.write(filePath, "old");
            yield* fileSystem.writeAtomic(filePath, "new");
            const text = yield* fileSystem.readText(filePath);
            const entries = yield* fileSystem.readDir(dir);
            return { entries, text };
          }),
        ).pipe(Effect.provide(FileSystemLive)),
      );

      expect(result.text).toBe("new");
      expect(result.entries).toEqual(["atomic.txt"]);
    });
  });

  test("keeps the destination intact until atomic rename", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "atomic.txt");
      await writeFile(filePath, "old");
      const replace = async (source: string, destination: string): Promise<void> => {
        expect(destination).toBe(filePath);
        expect(source).toMatch(/atomic\.txt\.tmp-[0-9a-f-]+$/);
        expect(await readFile(source, "utf8")).toBe("new");
        expect(await readFile(destination, "utf8")).toBe("old");
        throw new Error("simulated crash before rename");
      };

      await expect(writeAtomicFile(filePath, "new", replace)).rejects.toThrow(
        "simulated crash before rename",
      );

      expect(await readFile(filePath, "utf8")).toBe("old");
      expect(await readdir(dir)).toEqual(["atomic.txt"]);
    });
  });

  test("stat reports directories with isDirectory true", async () => {
    await withTempDir(async (dir) => {
      const subdir = join(dir, "nested");

      const stats = await Effect.runPromise(
        Effect.flatMap(FileSystem, (fileSystem) =>
          Effect.gen(function* () {
            yield* fileSystem.mkdir(subdir);
            return yield* fileSystem.stat(subdir);
          }),
        ).pipe(Effect.provide(FileSystemLive)),
      );

      expect(stats.isDirectory).toBe(true);
      expect(stats.isFile).toBe(false);
    });
  });

  test("stat on missing path fails with FileNotFoundError", async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, "no-such-thing");
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(FileSystem, (fileSystem) => fileSystem.stat(missing)).pipe(
          Effect.provide(FileSystemLive),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(FileNotFoundError);
          expect(failure.value.path).toBe(missing);
        }
      }
    });
  });
});
