import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { SqlDumpCompressionError } from "@lando/sdk/errors";

import {
  collectDumpPrefix,
  compressionFromExportPath,
  detectDumpCompression,
  withHostDumpCompression,
  writeDumpTransform,
} from "../src/compression.ts";
import { canUseFifo, captureFifo, feedFifo, mkfifo, stopProc, writeFifoPayload } from "./support/fifo.ts";

describe("dump compression helpers", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lando-sql-compression-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("detectDumpCompression prefers gzip and zstd magic over an empty prefix", () => {
    expect(detectDumpCompression(new Uint8Array())).toBe("none");
    expect(detectDumpCompression(Uint8Array.from([0x1f]))).toBe("none");
    expect(detectDumpCompression(Uint8Array.from([0x1f, 0x8b]))).toBe("gzip");
    expect(detectDumpCompression(Uint8Array.from([0x28, 0xb5, 0x2f]))).toBe("none");
    expect(detectDumpCompression(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe("zstd");
  });

  test("collectDumpPrefix waits for four bytes so split magic still detects", () => {
    const first = collectDumpPrefix(Uint8Array.from([0x28]), new Uint8Array());
    const second = collectDumpPrefix(Uint8Array.from([0xb5, 0x2f, 0xfd, 0x00]), first);
    expect(detectDumpCompression(first)).toBe("none");
    expect(detectDumpCompression(second)).toBe("zstd");
  });

  test("export suffix stays gzip for the default dump name", () => {
    expect(compressionFromExportPath("database.sql.gz")).toBe("gzip");
  });

  test("round-trips gzip through host CompressionStream", async () => {
    const source = join(dir, "plain.sql");
    const compressed = join(dir, "plain.sql.gz");
    const restored = join(dir, "restored.sql");
    await writeFile(source, "select 1;\n");

    await Effect.runPromise(writeDumpTransform(source, compressed, "gzip", "compress"));
    await Effect.runPromise(writeDumpTransform(compressed, restored, "gzip", "decompress"));

    expect(await readFile(restored, "utf8")).toBe("select 1;\n");
    expect(new Uint8Array(await readFile(compressed)).subarray(0, 2)).toEqual(Uint8Array.from([0x1f, 0x8b]));
  });

  test("round-trips zstd through host CompressionStream", async () => {
    const source = join(dir, "plain.sql");
    const compressed = join(dir, "plain.sql.zst");
    const restored = join(dir, "restored.sql");
    await writeFile(source, "select 2;\n");

    await Effect.runPromise(writeDumpTransform(source, compressed, "zstd", "compress"));
    await Effect.runPromise(writeDumpTransform(compressed, restored, "zstd", "decompress"));

    expect(await readFile(restored, "utf8")).toBe("select 2;\n");
    expect(new Uint8Array(await readFile(compressed)).subarray(0, 4)).toEqual(
      Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]),
    );
  });

  test("fails with SqlDumpCompressionError when zstd magic is a lie", async () => {
    const path = join(dir, "lie.sql.zst");
    await writeFile(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));

    const exit = await Effect.runPromiseExit(
      writeDumpTransform(path, join(dir, "out.sql"), "zstd", "decompress"),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlDumpCompressionError);
    if (!(error instanceof SqlDumpCompressionError)) return;
    expect(error.compression).toBe("zstd");
    expect(error.operation).toBe("decompress");
  });

  test("compresses an export onto a FIFO without renaming it into a regular file", async () => {
    if (!canUseFifo) return;
    const fifo = join(dir, "dump.sql.gz");
    const captured = join(dir, "captured.gz");
    await mkfifo(fifo);
    const reader = captureFifo(fifo, captured);
    try {
      const payload = "select 1;\n";
      await Effect.runPromise(
        withHostDumpCompression({
          path: fifo,
          compression: "gzip",
          direction: "export",
          transfer: (path) =>
            Effect.promise(async () => {
              await writeFile(path, payload);
              return { accelerated: true, sizeBytes: payload.length };
            }),
        }),
      );
      expect(await reader.exited).toBe(0);
      expect((await stat(fifo)).isFIFO()).toBe(true);
      expect(new Uint8Array(await readFile(captured)).subarray(0, 2)).toEqual(Uint8Array.from([0x1f, 0x8b]));
      const restored = await new Response(
        new Blob([await readFile(captured)]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).text();
      expect(restored).toBe(payload);
    } catch (error) {
      await stopProc(reader);
      throw error;
    }
  });

  test("imports an uncompressed FIFO without seeking the source", async () => {
    if (!canUseFifo) return;
    const fifo = join(dir, "dump.sql");
    const payload = "select 2;\n";
    const source = await writeFifoPayload(dir, "plain.sql", payload);
    await mkfifo(fifo);
    const writer = feedFifo(source, fifo);
    try {
      const result = await Effect.runPromise(
        withHostDumpCompression({
          path: fifo,
          compression: "none",
          direction: "import",
          transfer: (workingPath, digest) =>
            Effect.promise(async () => {
              expect(await readFile(workingPath, "utf8")).toBe(payload);
              expect(digest).toHaveLength(64);
              if (digest === undefined) throw new Error("expected digest");
              return { accelerated: false, sizeBytes: payload.length, digest };
            }),
        }),
      );
      expect(await writer.exited).toBe(0);
      expect(result.digest).toHaveLength(64);
    } catch (error) {
      await stopProc(writer);
      throw error;
    }
  });

  test("imports a gzip FIFO by decompressing in one pass to a staged file", async () => {
    if (!canUseFifo) return;
    const fifo = join(dir, "dump.sql.gz");
    const payload = "select 3;\n";
    const compressed = Buffer.from(
      await new Response(
        new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const source = await writeFifoPayload(dir, "plain.sql.gz", compressed);
    await mkfifo(fifo);
    const writer = feedFifo(source, fifo);
    try {
      await Effect.runPromise(
        withHostDumpCompression({
          path: fifo,
          compression: "none",
          direction: "import",
          transfer: (workingPath, digest) =>
            Effect.promise(async () => {
              expect(await readFile(workingPath, "utf8")).toBe(payload);
              expect(digest).toHaveLength(64);
              if (digest === undefined) throw new Error("expected digest");
              return { accelerated: false, sizeBytes: payload.length, digest };
            }),
        }),
      );
      expect(await writer.exited).toBe(0);
    } catch (error) {
      await stopProc(writer);
      throw error;
    }
  });
});
