import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Effect, Stream } from "effect";

import {
  DataChecksumMismatchError,
  SqlDumpCompressionError,
  SqlDumpEmptyError,
  SqlDumpStageError,
} from "@lando/sdk/errors";
import type { DataTransferResult } from "@lando/sdk/schema";
import { VerifiedStreamPartialError, persistVerifiedStream } from "@lando/sdk/verified-stream";

import { isNonRegularExistingPath } from "./dump-stdio.ts";

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

const dumpStageError = (path: string): SqlDumpStageError =>
  new SqlDumpStageError({
    message: `Failed to stage dump file: ${path}`,
    path,
    remediation: "Confirm the dump is readable and the host temp directory is writable, then retry.",
  });

const dumpEmptyError = (path: string): SqlDumpEmptyError =>
  new SqlDumpEmptyError({
    message: `Dump is empty: ${path}`,
    path,
    remediation: "Pass a non-empty dump. Empty stdin is rejected.",
  });

const mapPersistError = (
  error: unknown,
  fallback: SqlDumpCompressionError | SqlDumpStageError,
): SqlDumpCompressionError | SqlDumpStageError | VerifiedStreamPartialError => {
  if (error instanceof VerifiedStreamPartialError) return error;
  return fallback;
};

export const writeDumpTransform = (
  sourcePath: string,
  destPath: string,
  compression: Exclude<DumpCompression, "none">,
  operation: "compress" | "decompress",
  expectedDigest?: string,
): Effect.Effect<
  { readonly digest: string; readonly sizeBytes: number },
  SqlDumpCompressionError | SqlDumpStageError | DataChecksumMismatchError | VerifiedStreamPartialError
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
      const fallback = dumpCompressionError(
        operation === "compress" ? destPath : sourcePath,
        compression,
        operation,
      );
      const result = yield* persistVerifiedStream({
        body: Stream.fromReadableStream({
          evaluate: () => streamThrough(source, compression, operation),
          onError: () => dumpCompressionError(sourcePath, compression, operation),
          releaseLockOnEnd: true,
        }),
        destinationPath: destPath,
        mode: 0o600,
      }).pipe(Effect.mapError((error) => mapPersistError(error, fallback)));
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

export const acquireStagedDump = (parent: string): Effect.Effect<string, SqlDumpStageError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(parent, { recursive: true });
      return mkdtemp(join(parent, ".lando-dump-"));
    },
    catch: () => dumpStageError(parent),
  });

export const releaseStagedDump = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { recursive: true, force: true }));

const peekDumpSource = async (
  path: string,
): Promise<{ readonly compression: DumpCompression; readonly source: ReadableStream<Uint8Array> }> => {
  const reader = Bun.file(path).stream().getReader();
  let prefix: Uint8Array = new Uint8Array();
  const pending: Uint8Array[] = [];
  while (prefix.byteLength < 4) {
    const next = await reader.read();
    if (next.done) break;
    pending.push(next.value);
    prefix = collectDumpPrefix(next.value, prefix);
  }
  let index = 0;
  return {
    compression: detectDumpCompression(prefix),
    source: new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const queued = pending[index];
        if (queued !== undefined) {
          index += 1;
          controller.enqueue(queued);
          return;
        }
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      cancel: () => reader.cancel(),
    }),
  };
};

const stageStreamingImport = (
  sourcePath: string,
  destPath: string,
): Effect.Effect<
  { readonly digest: string; readonly sizeBytes: number },
  SqlDumpCompressionError | SqlDumpStageError | SqlDumpEmptyError | VerifiedStreamPartialError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const peeked = yield* Effect.tryPromise({
        try: () => peekDumpSource(sourcePath),
        catch: () => dumpStageError(sourcePath),
      });
      const body =
        peeked.compression === "none"
          ? peeked.source
          : streamThrough(peeked.source, peeked.compression, "decompress");
      const persistError =
        peeked.compression === "none"
          ? dumpStageError(sourcePath)
          : dumpCompressionError(sourcePath, peeked.compression, "decompress");
      const result = yield* persistVerifiedStream({
        body: Stream.fromReadableStream({
          evaluate: () => body,
          onError: () => persistError,
          releaseLockOnEnd: true,
        }),
        destinationPath: destPath,
        mode: 0o600,
      }).pipe(Effect.mapError((error) => mapPersistError(error, persistError)));
      if (result.sizeBytes === 0) return yield* Effect.fail(dumpEmptyError(sourcePath));
      return { digest: result.sha256, sizeBytes: result.sizeBytes };
    }),
  );

export const withHostDumpCompression = Effect.fn("Sql.withHostDumpCompression")(function* <E, R>(input: {
  readonly path: string;
  readonly compression: DumpCompression;
  readonly direction: "export" | "import";
  readonly expectedDigest?: string;
  readonly transfer: (workingPath: string, digest?: string) => Effect.Effect<DataTransferResult, E, R>;
}) {
  const special = yield* isNonRegularExistingPath(input.path);
  if (input.direction === "import" && special) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(acquireStagedDump(tmpdir()), releaseStagedDump);
        const staged = join(directory, "dump");
        const stagedDump = yield* stageStreamingImport(input.path, staged);
        return yield* input.transfer(staged, stagedDump.digest);
      }),
    );
  }
  const compression = input.compression;
  if (compression === "none") return yield* input.transfer(input.path);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        acquireStagedDump(input.direction === "export" && !special ? dirname(input.path) : tmpdir()),
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
      const compressed = yield* writeDumpTransform(staged, input.path, compression, "compress");
      return { ...result, ...compressed };
    }),
  );
});
