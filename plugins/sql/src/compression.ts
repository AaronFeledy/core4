import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Effect } from "effect";

import { SqlDumpCompressionError } from "@lando/sdk/errors";

export type DumpCompression = "gzip" | "zstd" | "none";

const GZIP_MAGIC = [0x1f, 0x8b] as const;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

export const isGzipPath = (path: string): boolean => basename(path).endsWith(".gz");

export const isZstdPath = (path: string): boolean => basename(path).endsWith(".zst");

export const compressionFromExportPath = (path: string): DumpCompression => {
  if (isZstdPath(path)) return "zstd";
  if (isGzipPath(path)) return "gzip";
  return "none";
};

export const detectDumpCompression = (prefix: Uint8Array): DumpCompression => {
  if (prefix.length >= 2 && prefix[0] === GZIP_MAGIC[0] && prefix[1] === GZIP_MAGIC[1]) return "gzip";
  if (
    prefix.length >= 4 &&
    prefix[0] === ZSTD_MAGIC[0] &&
    prefix[1] === ZSTD_MAGIC[1] &&
    prefix[2] === ZSTD_MAGIC[2] &&
    prefix[3] === ZSTD_MAGIC[3]
  ) {
    return "zstd";
  }
  return "none";
};

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};

export const collectDumpPrefix = (chunk: Uint8Array, prefix: Uint8Array): Uint8Array =>
  prefix.byteLength >= 4 ? prefix : appendBytes(prefix, chunk);

const streamThrough = (
  source: ReadableStream<Uint8Array>,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
): ReadableStream<Uint8Array> =>
  source.pipeThrough(
    operation === "compress" ? new CompressionStream(compression) : new DecompressionStream(compression),
  );

const persistWebStream = async (
  source: ReadableStream<Uint8Array>,
  destPath: string,
): Promise<{ readonly digest: string; readonly sizeBytes: number }> => {
  await mkdir(dirname(destPath), { recursive: true });
  const hash = new Bun.CryptoHasher("sha256");
  const handle = await open(destPath, "w");
  const reader = source.getReader();
  let sizeBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await handle.write(value);
      sizeBytes += value.byteLength;
    }
    await handle.sync().catch(() => undefined);
  } finally {
    reader.releaseLock();
    await handle.close().catch(() => undefined);
  }
  return { digest: hash.digest("hex"), sizeBytes };
};

const dumpCompressionError = (
  path: string,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
): SqlDumpCompressionError =>
  new SqlDumpCompressionError({
    message:
      operation === "compress"
        ? `Failed to compress dump file: ${path}`
        : `Failed to decompress dump file: ${path}`,
    path,
    compression,
    operation,
    remediation:
      operation === "compress"
        ? "Retry the export after checking host disk space. Dump compression runs on the host process, not inside the database service."
        : "Confirm the dump starts with gzip or zstd magic bytes, then retry the import.",
  });

export const writeDumpTransform = (
  sourcePath: string,
  destPath: string,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
): Effect.Effect<{ readonly digest: string; readonly sizeBytes: number }, SqlDumpCompressionError> =>
  Effect.tryPromise({
    try: async () =>
      persistWebStream(streamThrough(Bun.file(sourcePath).stream(), compression, operation), destPath),
    catch: () =>
      dumpCompressionError(operation === "compress" ? destPath : sourcePath, compression, operation),
  });

export const acquireStagedDump = (): Effect.Effect<string, never, never> =>
  Effect.sync(() => join(tmpdir(), `lando-dump-${randomUUID()}`));

export const releaseStagedDump = (path: string): Effect.Effect<void> =>
  Effect.promise(() => unlink(path).catch(() => undefined)).pipe(Effect.asVoid);

export const withHostDumpCompression = <A, E, R>(input: {
  readonly path: string;
  readonly compression: DumpCompression;
  readonly direction: "export" | "import";
  readonly expectedDigest?: string;
  readonly transfer: (workingPath: string, digest?: string) => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | SqlDumpCompressionError, R> => {
  const compression = input.compression;
  if (compression === "none") return input.transfer(input.path, input.expectedDigest);
  return Effect.scoped(
    Effect.gen(function* () {
      const staged = yield* Effect.acquireRelease(acquireStagedDump(), releaseStagedDump);
      if (input.direction === "import") {
        const decompressed = yield* writeDumpTransform(input.path, staged, compression, "decompress");
        return yield* input.transfer(staged, decompressed.digest);
      }
      const result = yield* input.transfer(staged);
      yield* writeDumpTransform(staged, input.path, compression, "compress");
      return result;
    }),
  );
};
