import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { SqlDumpCompressionError, errnoCode } from "@lando/sdk/errors";
import type { DataTransferResult } from "@lando/sdk/schema";
import { VerifiedStreamError, persistVerifiedStream } from "@lando/sdk/verified-stream";
import { Effect, type Scope, Stream, absurd } from "effect";

export type DumpCompression = "gzip" | "zstd" | "none";

const GZIP_MAGIC = [0x1f, 0x8b] as const;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

export const isGzipPath = (path: string): boolean => basename(path).toLowerCase().endsWith(".gz");

export const isZstdPath = (path: string): boolean => basename(path).toLowerCase().endsWith(".zst");

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

const DUMP_PREFIX_LIMIT = 16;

export const collectDumpPrefix = (chunk: Uint8Array, prefix: Uint8Array): Uint8Array =>
  prefix.byteLength >= DUMP_PREFIX_LIMIT ? prefix : appendBytes(prefix, chunk);

const streamThrough = (
  source: ReadableStream<Uint8Array>,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
  level?: number,
): ReadableStream<Uint8Array> => {
  switch (operation) {
    case "compress":
      return source.pipeThrough(
        level === undefined
          ? new CompressionStream(compression)
          : new CompressionStream(compression, { level }),
      );
    case "decompress":
      return source.pipeThrough(new DecompressionStream(compression));
    default:
      return absurd(operation);
  }
};

const filesystemRemediation = (cause: unknown): string | undefined => {
  switch (errnoCode(cause instanceof VerifiedStreamError ? cause.cause : cause)) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "Verify the destination directory is writable, then retry.";
    case "ENOSPC":
    case "EDQUOT":
      return "Check host disk space and storage quota, then retry.";
    case "ENOENT":
    case "ENOTDIR":
    case "EEXIST":
      return "Verify the dump path and its parent directory are valid, then retry.";
    default:
      return undefined;
  }
};

const dumpCompressionError = (input: {
  readonly path: string;
  readonly compression: Exclude<DumpCompression, "none">;
  readonly operation: "compress" | "decompress";
  readonly cause: unknown;
}): SqlDumpCompressionError =>
  new SqlDumpCompressionError({
    ...input,
    message:
      input.operation === "compress"
        ? `Failed to compress dump file: ${input.path}`
        : `Failed to decompress dump file: ${input.path}`,
    remediation:
      filesystemRemediation(input.cause) ??
      (input.operation === "compress"
        ? "Check the underlying error and the dump source and destination paths, then retry the export. Dump compression runs on the host process, not inside the database service."
        : "Confirm the dump starts with gzip or zstd magic bytes, then retry the import."),
  });

export const writeDumpTransform = (
  sourcePath: string,
  destPath: string,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
  level?: number,
): Effect.Effect<{ readonly digest: string; readonly sizeBytes: number }, SqlDumpCompressionError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* persistVerifiedStream({
        body: Stream.unwrap(
          Effect.try({
            try: () => streamThrough(Bun.file(sourcePath).stream(), compression, operation, level),
            catch: (cause) => dumpCompressionError({ path: sourcePath, compression, operation, cause }),
          }).pipe(
            Effect.map((transformed) =>
              Stream.fromReadableStream({
                evaluate: () => transformed,
                onError: (cause) => dumpCompressionError({ path: sourcePath, compression, operation, cause }),
                releaseLockOnEnd: true,
              }),
            ),
          ),
        ),
        destinationPath: destPath,
        mode: 0o600,
      }).pipe(
        mapFailures((cause) =>
          cause instanceof SqlDumpCompressionError
            ? cause
            : dumpCompressionError({ path: destPath, compression, operation, cause }),
        ),
      );
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
    catch: (cause) =>
      new SqlDumpCompressionError({
        message: `Failed to create a dump staging directory in ${parent}`,
        path: parent,
        compression,
        operation,
        cause,
        remediation:
          filesystemRemediation(cause) ??
          "Check the underlying error and the destination directory, then retry the export.",
      }),
  });

export const releaseStagedDump = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { recursive: true, force: true }));

/** Exports through a staged plaintext file beside the destination, then compresses into place. */
export const withHostDumpCompression = <E, R>(input: {
  readonly path: string;
  readonly compression: DumpCompression;
  readonly compressionLevel?: number;
  readonly transfer: (workingPath: string) => Effect.Effect<DataTransferResult, E, R>;
}): Effect.Effect<DataTransferResult, E | SqlDumpCompressionError, R> => {
  const compression = input.compression;
  if (compression === "none") return input.transfer(input.path);
  return Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        acquireStagedDump(dirname(input.path), compression, "compress"),
        releaseStagedDump,
      );
      const staged = join(directory, "dump");
      const result = yield* input.transfer(staged);
      const compressed = yield* writeDumpTransform(
        staged,
        input.path,
        compression,
        "compress",
        input.compressionLevel,
      );
      return { ...result, ...compressed };
    }),
  );
};

/** Compresses a dump on its way to stdout. Cancelling the result cancels the source stream. */
export const compressDumpStream = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  compression: Exclude<DumpCompression, "none">,
  level?: number,
): Stream.Stream<Uint8Array, unknown, Exclude<R, Scope.Scope>> =>
  Stream.unwrap(
    Effect.map(Stream.toReadableStreamEffect(body), (readable) =>
      Stream.fromReadableStream({
        evaluate: () => streamThrough(readable, compression, "compress", level),
        onError: (cause) => cause,
      }),
    ),
  );
