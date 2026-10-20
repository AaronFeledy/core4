import { createHash } from "node:crypto";
import { open as fsOpen, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Schema, Stream } from "effect";

import {
  VerifiedStreamError,
  collectVerifiedStream,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

class FakeBodyError extends Schema.TaggedError<FakeBodyError>()("FakeBodyError", {
  message: Schema.String,
}) {}

const tempFiles = async (dir: string, target: string): Promise<ReadonlyArray<string>> => {
  const prefix = `${basename(target)}.tmp-`;
  const entries = await readdir(dir);
  return entries.filter((entry) => entry.startsWith(prefix));
};

const withTempDir = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-verified-stream-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("persistVerifiedStream", () => {
  test("S1 streams chunks into the destination, hashing and counting", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "artifact.bin");
      const chunks = [bytes("hello "), bytes("verified "), bytes("world")];
      const all = concat(chunks);

      const result = await Effect.runPromise(
        Effect.scoped(
          persistVerifiedStream({
            body: Stream.fromIterable(chunks),
            destinationPath: target,
            expectedSha256: sha256Hex(all),
            expectedSizeBytes: all.length,
          }),
        ),
      );

      expect(result.sha256).toBe(sha256Hex(all));
      expect(result.sizeBytes).toBe(all.length);
      expect(Array.from(await readFile(target))).toEqual(Array.from(all));
      expect(await tempFiles(dirname(target), target)).toEqual([]);
    });
  });

  test("S5 checksum mismatch fails, leaves no temp, does not clobber an existing file", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "artifact.bin");
      await writeFile(target, bytes("original-bytes"));

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          persistVerifiedStream({
            body: Stream.fromIterable([bytes("different")]),
            destinationPath: target,
            expectedSha256: "a".repeat(64),
          }),
        ),
      );

      expect(exit._tag).toBe("Failure");
      const error = await Effect.runPromise(
        Effect.scoped(
          persistVerifiedStream({
            body: Stream.fromIterable([bytes("different")]),
            destinationPath: join(dir, "throwaway.bin"),
            expectedSha256: "a".repeat(64),
          }),
        ).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(VerifiedStreamError);
      expect(error.reason).toBe("checksum");
      // existing file untouched
      expect(Array.from(await readFile(target))).toEqual(Array.from(bytes("original-bytes")));
      expect(await tempFiles(dirname(target), target)).toEqual([]);
    });
  });

  test("S6 size mismatch fails and leaves no temp", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "artifact.bin");
      const payload = bytes("12345");

      const error = await Effect.runPromise(
        Effect.scoped(
          persistVerifiedStream({
            body: Stream.fromIterable([payload]),
            destinationPath: target,
            expectedSizeBytes: 999,
          }),
        ).pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(VerifiedStreamError);
      expect((error as VerifiedStreamError).reason).toBe("size");
      expect(await tempFiles(dirname(target), target)).toEqual([]);
    });
  });

  test("S7 stream body failure propagates and leaves no temp or destination", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "artifact.bin");
      const body = Stream.concat(
        Stream.fromIterable([bytes("partial")]),
        Stream.fail(new FakeBodyError({ message: "boom" })),
      );

      const error = await Effect.runPromise(
        Effect.scoped(persistVerifiedStream({ body, destinationPath: target })).pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(FakeBodyError);
      expect(await tempFiles(dirname(target), target)).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test("S8 interrupt mid-stream removes the temp file", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "artifact.bin");
      // emit one chunk, then never finish
      const body = Stream.concat(Stream.fromIterable([bytes("chunk")]), Stream.never);

      const program = Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.scoped(persistVerifiedStream({ body, destinationPath: target })),
        );
        // wait until the temp file appears
        let attempts = 0;
        yield* Effect.whileLoop({
          while: () => attempts < 200,
          body: () =>
            Effect.gen(function* () {
              const temps = yield* Effect.promise(() => tempFiles(dir, target));
              if (temps.length > 0) return 1000;
              yield* Effect.sleep("5 millis");
              return attempts + 1;
            }),
          step: (next) => {
            attempts = next;
          },
        });
        yield* Fiber.interrupt(fiber);
      });

      await Effect.runPromise(program);
      // small settle
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await tempFiles(dir, target)).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test("writes a FIFO in place without a temp sibling or rename", async () => {
    if (process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const fifo = join(dir, "dump.fifo");
      const captured = join(dir, "captured.bin");
      const payload = bytes("fifo-dump-bytes");
      const mk = Bun.spawn(["mkfifo", "-m", "0600", fifo], { stdout: "ignore", stderr: "pipe" });
      expect(await mk.exited).toBe(0);
      const reader = Bun.spawn(["cat", fifo], { stdout: Bun.file(captured), stderr: "ignore" });
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            persistVerifiedStream({
              body: Stream.fromIterable([payload]),
              destinationPath: fifo,
            }),
          ),
        );
        expect(await reader.exited).toBe(0);
        expect(result.sha256).toBe(sha256Hex(payload));
        expect(result.sizeBytes).toBe(payload.length);
        expect(Array.from(await readFile(captured))).toEqual(Array.from(payload));
        expect((await stat(fifo)).isFIFO()).toBe(true);
        expect(await tempFiles(dir, fifo)).toEqual([]);
      } catch (error) {
        reader.kill();
        await reader.exited.catch(() => undefined);
        throw error;
      }
    });
  });

  test("writes process-substitution-style /dev/fd destinations in place", async () => {
    if (process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const fifo = join(dir, "dump.fifo");
      const captured = join(dir, "captured.bin");
      const payload = bytes("fd-dump-bytes");
      const mk = Bun.spawn(["mkfifo", "-m", "0600", fifo], { stdout: "ignore", stderr: "pipe" });
      expect(await mk.exited).toBe(0);
      const reader = Bun.spawn(["cat", fifo], { stdout: Bun.file(captured), stderr: "ignore" });
      const writer = await fsOpen(fifo, "w");
      try {
        const dest = `/dev/fd/${writer.fd}`;
        const result = await Effect.runPromise(
          Effect.scoped(
            persistVerifiedStream({
              body: Stream.fromIterable([payload]),
              destinationPath: dest,
            }),
          ),
        );
        await writer.close();
        expect(await reader.exited).toBe(0);
        expect(result.sha256).toBe(sha256Hex(payload));
        expect(Array.from(await readFile(captured))).toEqual(Array.from(payload));
        expect((await stat(fifo)).isFIFO()).toBe(true);
        expect(await tempFiles(dir, fifo)).toEqual([]);
      } catch (error) {
        await writer.close().catch(() => undefined);
        reader.kill();
        await reader.exited.catch(() => undefined);
        throw error;
      }
    });
  });

  test("stdout persist writes only the dump bytes on stdout", async () => {
    if (process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const script = join(dir, "stdout-dump.ts");
      const payload = "STDOUT-DUMP-ONLY";
      const verifiedStream = join(import.meta.dir, "..", "..", "sdk/src/verified-stream/index.ts");
      await writeFile(
        script,
        `import { Effect, Stream } from "effect";
import { persistVerifiedStream } from ${JSON.stringify(verifiedStream)};
const payload = new TextEncoder().encode(${JSON.stringify(payload)});
await Effect.runPromise(
  Effect.scoped(
    persistVerifiedStream({
      body: Stream.fromIterable([payload]),
      destinationPath: "/dev/stdout",
    }),
  ),
);
`,
      );
      const proc = Bun.spawn([process.execPath, script], {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || `stdout dump helper exited ${code}`);
      expect(stdout).toBe(payload);
      expect(stderr).toBe("");
    });
  });
});

describe("collectVerifiedStream", () => {
  test("S9 buffers in memory and returns sha256 + size without touching disk", async () => {
    const chunks = [bytes("in-"), bytes("memory")];
    const all = concat(chunks);
    const result = await Effect.runPromise(
      collectVerifiedStream({
        body: Stream.fromIterable(chunks),
        expectedSha256: sha256Hex(all),
        expectedSizeBytes: all.length,
      }),
    );
    expect(result.sha256).toBe(sha256Hex(all));
    expect(result.sizeBytes).toBe(all.length);
  });

  test("checksum mismatch fails in memory mode", async () => {
    const error = await Effect.runPromise(
      collectVerifiedStream({
        body: Stream.fromIterable([bytes("data")]),
        expectedSha256: "b".repeat(64),
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(VerifiedStreamError);
    expect((error as VerifiedStreamError).reason).toBe("checksum");
  });
});
