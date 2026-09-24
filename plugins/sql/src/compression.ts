import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
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
  if (left.byteLength === 0) return right;
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

const hashFile = async (path: string): Promise<string> => {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
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
    try: async () => {
      await mkdir(dirname(destPath), { recursive: true });
      const body = streamThrough(Bun.file(sourcePath).stream(), compression, operation);
      await Bun.write(destPath, body);
      const info = await stat(destPath);
      return { digest: await hashFile(destPath), sizeBytes: info.size };
    },
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
  if (input.compression === "none") return input.transfer(input.path, input.expectedDigest);
  return Effect.scoped(
    Effect.gen(function* () {
      const staged = yield* Effect.acquireRelease(acquireStagedDump(), releaseStagedDump);
      if (input.direction === "import") {
        const decompressed = yield* writeDumpTransform(input.path, staged, input.compression, "decompress");
        return yield* input.transfer(staged, decompressed.digest);
      }
      const result = yield* input.transfer(staged);
      yield* writeDumpTransform(staged, input.path, input.compression, "compress");
      return result;
    }),
  );
};
