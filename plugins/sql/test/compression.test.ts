import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { SqlDumpCompressionError } from "@lando/sdk/errors";

import {
  collectDumpPrefix,
  compressionFromExportPath,
  detectDumpCompression,
  writeDumpTransform,
} from "../src/compression.ts";

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
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(SqlDumpCompressionError);
    if (!(error instanceof SqlDumpCompressionError)) return;
    expect(error.compression).toBe("zstd");
    expect(error.operation).toBe("decompress");
  });
});
