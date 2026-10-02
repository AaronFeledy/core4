import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Effect, Stream } from "effect";

import { DataChecksumMismatchError, SqlDumpCompressionError } from "@lando/sdk/errors";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";

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
  expectedDigest?: string,
): Effect.Effect<
  { readonly digest: string; readonly sizeBytes: number },
  SqlDumpCompressionError | DataChecksumMismatchError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const hash = new Bun.CryptoHasher("sha256");
      const source = Bun.file(sourcePath)
        .stream()
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
              hash.update(chunk);
              controller.enqueue(chunk);
            },
          }),
        );
      const result = yield* persistVerifiedStream({
        body: Stream.fromReadableStream({
          evaluate: () => streamThrough(source, compression, operation),
          onError: () => dumpCompressionError(sourcePath, compression, operation),
          releaseLockOnEnd: true,
        }),
        destinationPath: destPath,
        mode: 0o600,
      }).pipe(
        Effect.mapError(() =>
          dumpCompressionError(operation === "compress" ? destPath : sourcePath, compression, operation),
        ),
      );
      const actualDigest = hash.digest("hex");
      if (expectedDigest !== undefined && actualDigest !== expectedDigest) {
        return yield* Effect.fail(
          new DataChecksumMismatchError({
            message: "The compressed dump changed after it was selected for import.",
            expectedSha256: expectedDigest,
            actualSha256: actualDigest,
            archivePath: sourcePath,
            remediation: "Select the dump again and retry the import.",
          }),
        );
      }
      return { digest: result.sha256, sizeBytes: result.sizeBytes };
    }),
  );

export const acquireStagedDump = (
  parent: string,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
): Effect.Effect<string, SqlDumpCompressionError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(parent, { recursive: true });
      return mkdtemp(join(parent, ".lando-dump-"));
    },
    catch: () => dumpCompressionError(parent, compression, operation),
  });

export const releaseStagedDump = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { recursive: true, force: true }));

export const withHostDumpCompression = <A, E, R>(input: {
  readonly path: string;
  readonly compression: DumpCompression;
  readonly direction: "export" | "import";
  readonly expectedDigest?: string;
  readonly transfer: (workingPath: string, digest?: string) => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | SqlDumpCompressionError | DataChecksumMismatchError, R> => {
  const compression = input.compression;
  if (compression === "none") return input.transfer(input.path);
  return Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        acquireStagedDump(
          input.direction === "export" ? dirname(input.path) : tmpdir(),
          compression,
          input.direction === "export" ? "compress" : "decompress",
        ),
        releaseStagedDump,
      );
      const staged = join(directory, "dump");
      if (input.direction === "import") {
        const decompressed = yield* writeDumpTransform(
          input.path,
          staged,
          compression,
          "decompress",
          input.expectedDigest,
        );
        return yield* input.transfer(staged, decompressed.digest);
      }
      const result = yield* input.transfer(staged);
      yield* writeDumpTransform(staged, input.path, compression, "compress");
      return result;
    }),
  );
};
