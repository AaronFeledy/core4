import { constants } from "node:fs";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Stream } from "effect";

import {
  CommandInputValidationError,
  CommandStdioError,
  DataTransferError,
  SqlDumpCompressionError,
  SqlDumpIncompleteError,
  SqlDumpNotFoundError,
  errnoCode,
} from "@lando/sdk/errors";
import { VerifiedStreamError, persistVerifiedStream } from "@lando/sdk/verified-stream";

import {
  type DumpCompression,
  collectDumpPrefix,
  detectDumpCompression,
  releaseStagedDump,
} from "./compression.ts";

type DumpMiss = "missing" | "unreadable" | "directory";

const dumpMissKind = (cause: unknown): DumpMiss => {
  const code = errnoCode(cause);
  if (code === "EACCES" || code === "EPERM") return "unreadable";
  return "missing";
};

const dumpNotFound = (path: string, appRoot: string, kind: DumpMiss): SqlDumpNotFoundError => {
  const message =
    kind === "unreadable"
      ? `Dump file is not readable: ${path}`
      : kind === "directory"
        ? `Dump path is a directory, not a file: ${path}`
        : `Dump file not found: ${path}`;
  return new SqlDumpNotFoundError({
    message,
    path,
    appRoot,
    remediation: `Check the path. Relative paths resolve from the current directory when inside the app, otherwise from the app root (${appRoot}).`,
  });
};

/** Cheap existence and permission checks, so a bad path fails before the count probe and prompt. */
export const ensureDumpFile = (path: string, appRoot: string): Effect.Effect<void, SqlDumpNotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(path);
      if (info.isDirectory()) throw dumpNotFound(path, appRoot, "directory");
      // `stat` succeeds on a file the current user cannot open.
      await access(path, constants.R_OK);
    },
    catch: (cause) =>
      cause instanceof SqlDumpNotFoundError ? cause : dumpNotFound(path, appRoot, dumpMissKind(cause)),
  });

const EDGE_BYTES = 512;

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};

const lastBytes = (bytes: Uint8Array): Uint8Array =>
  bytes.byteLength > EDGE_BYTES ? bytes.slice(-EDGE_BYTES) : bytes;

const isAsciiWhitespace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

const lastContentIndex = (chunk: Uint8Array): number => {
  for (let index = chunk.byteLength - 1; index >= 0; index -= 1) {
    if (!isAsciiWhitespace(chunk[index] ?? 0x20)) return index;
  }
  return -1;
};

/**
 * Keeps the first bytes of a dump and the last bytes before any trailing whitespace, so
 * completeness can be checked during the single read without buffering the dump.
 */
const trackDumpEdges = () => {
  let head: Uint8Array = new Uint8Array();
  let tail: Uint8Array = new Uint8Array();
  let trailingWhitespace: Uint8Array = new Uint8Array();
  let size = 0;
  return {
    push: (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (head.byteLength < EDGE_BYTES)
        head = concatBytes(head, chunk.subarray(0, EDGE_BYTES - head.byteLength));
      const last = lastContentIndex(chunk);
      if (last === -1) {
        trailingWhitespace = lastBytes(concatBytes(trailingWhitespace, chunk));
        return;
      }
      const content = chunk.subarray(0, last + 1);
      tail =
        content.byteLength >= EDGE_BYTES
          ? content.slice(-EDGE_BYTES)
          : lastBytes(concatBytes(concatBytes(tail, trailingWhitespace), content));
      trailingWhitespace = lastBytes(chunk.subarray(last + 1));
    },
    edges: () => ({ head, tail, size }),
  };
};

const MONGO_ARCHIVE_MAGIC = [0x6d, 0xe2, 0x99, 0x81] as const;
const MONGO_ARCHIVE_TERMINATOR = [0xff, 0xff, 0xff, 0xff] as const;

const startsWithBytes = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

const endsWithBytes = (bytes: Uint8Array, suffix: ReadonlyArray<number>): boolean =>
  startsWithBytes(bytes.subarray(bytes.byteLength - suffix.length), suffix);

type DumpEdgeText = { readonly bytes: Uint8Array; readonly text: string };

// Dump tools stamp a header near the start and a completion trailer at the end; a header without
// its trailer means the tool stopped early. Trailers must be whole lines, so a SQL string that
// happens to contain one doesn't count. Hand-written SQL has no header and is never rejected here.
const DUMP_FORMATS: ReadonlyArray<{
  readonly header: (head: DumpEdgeText) => boolean;
  readonly complete: (tail: DumpEdgeText) => boolean;
}> = [
  {
    // mysqldump and mariadb-dump end with "-- Dump completed" (plus " on <date>" unless skipped).
    header: (head) => /^-- (?:MySQL|MariaDB) dump /mu.test(head.text),
    complete: (tail) => /(?:^|\n)-- Dump completed(?: on [^\n]*)?\r?$/u.test(tail.text),
  },
  {
    // pg_dump's trailer may be followed by \unrestrict and comment lines.
    header: (head) => /^-- PostgreSQL database dump\r?$/mu.test(head.text),
    complete: (tail) => /^-- PostgreSQL database dump complete\r?$/mu.test(tail.text),
  },
  {
    header: (head) => startsWithBytes(head.bytes, MONGO_ARCHIVE_MAGIC),
    complete: (tail) => endsWithBytes(tail.bytes, MONGO_ARCHIVE_TERMINATOR),
  },
];

export type DumpEdges = { readonly head: Uint8Array; readonly tail: Uint8Array; readonly size: number };

export const dumpIncompleteReason = (edges: DumpEdges): "empty" | "truncated" | undefined => {
  if (edges.size === 0) return "empty";
  const decoder = new TextDecoder();
  const head = { bytes: edges.head, text: decoder.decode(edges.head) };
  const format = DUMP_FORMATS.find((candidate) => candidate.header(head));
  if (format === undefined) return undefined;
  return format.complete({ bytes: edges.tail, text: decoder.decode(edges.tail) }) ? undefined : "truncated";
};

const requireCompleteDump = (label: string, fromStdin: boolean, edges: DumpEdges) => {
  const reason = dumpIncompleteReason(edges);
  if (reason === undefined) return Effect.void;
  const source = fromStdin ? "the command feeding stdin" : "the dump file";
  const truncatedRemediation = fromStdin
    ? "Recreate the dump and check that the export command succeeded (in bash, set -o pipefail), then retry."
    : "Recreate the dump file and check that the export command succeeded, then retry.";
  return Effect.fail(
    new SqlDumpIncompleteError({
      message:
        reason === "empty"
          ? `The dump from ${label} is empty.`
          : `The dump from ${label} ends before its completion marker, so the tool that wrote it stopped early.`,
      path: label,
      reason,
      remediation:
        reason === "empty" ? `Check that ${source} produced a dump, then retry.` : truncatedRemediation,
    }),
  );
};

const stageError = (cause: unknown): DataTransferError =>
  new DataTransferError({
    message: "Failed to stage the dump in the host temp directory.",
    toEndpoint: "hostPath",
    operation: "stage",
    remediation:
      "Check that the host temp directory is writable and has room for the uncompressed dump, then retry.",
    cause,
  });

const decompressError = (label: string, compression: Exclude<DumpCompression, "none">) =>
  new SqlDumpCompressionError({
    message: `Failed to decompress dump: ${label}`,
    path: label,
    compression,
    operation: "decompress",
    remediation: `The ${compression} data is corrupt or cut short. Recreate the dump, then retry the import.`,
  });

/**
 * Reads the first bytes for magic detection, then hands back a stream that still starts at byte 0.
 * Aborting `signal` cancels the source, and `sourceFailure` remembers a read error so it isn't
 * mistaken for corrupt compression after it passes through a decompressor.
 */
const peekCompression = async (source: ReadableStream<Uint8Array>, signal: AbortSignal) => {
  const reader = source.getReader();
  const cancel = () => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let sourceFailure: { readonly cause: unknown } | undefined;
  const read = async () => {
    try {
      return await reader.read();
    } catch (cause) {
      sourceFailure = { cause };
      throw cause;
    }
  };
  const pending: Uint8Array[] = [];
  let prefix: Uint8Array = new Uint8Array();
  try {
    while (prefix.byteLength < 4) {
      const next = await read();
      if (next.done) break;
      pending.push(next.value);
      prefix = collectDumpPrefix(next.value, prefix);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const queued = pending.shift();
      if (queued !== undefined) {
        controller.enqueue(queued);
        return;
      }
      const next = await read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { compression: detectDumpCompression(prefix), body, sourceFailure: () => sourceFailure };
};

export type PreparedDump = {
  /** Plaintext dump to import: the original file, or an owner-only staged copy. */
  readonly path: string;
  readonly digest: string;
};

/**
 * Reads an import or seed dump once: detects gzip or zstd from its bytes, decompresses and stages
 * stdin or compressed input in an owner-only temp file that lives until the surrounding scope
 * closes, hashes the plaintext, and rejects an empty or truncated dump. An uncompressed file is
 * hashed in place, never copied.
 */
export const prepareImportDump = Effect.fn("Sql.prepareImportDump")(function* (input: {
  readonly file: string;
  readonly appRoot: string;
  readonly stdin?: Stream.Stream<Uint8Array, CommandStdioError>;
}) {
  const fromStdin = input.stdin !== undefined;
  const label = fromStdin ? "stdin" : input.file;
  const readFailure = (cause: unknown) => {
    if (cause instanceof CommandStdioError) return cause;
    if (fromStdin) return stageError(cause);
    return dumpNotFound(input.file, input.appRoot, dumpMissKind(cause));
  };
  // Peeking stays interruptible (aborting cancels the source). The release cancels a source nothing
  // consumed; a consumed one is cancelled by its consumer.
  const opened = yield* Effect.acquireRelease(
    Effect.interruptible(
      Effect.tryPromise({
        try: (signal) =>
          peekCompression(
            input.stdin === undefined ? Bun.file(input.file).stream() : Stream.toReadableStream(input.stdin),
            signal,
          ),
        catch: readFailure,
      }),
    ),
    ({ body }) => Effect.promise(() => body.cancel().catch(() => undefined)),
  );
  const tracker = trackDumpEdges();

  if (opened.compression === "none" && !fromStdin) {
    const hash = new Bun.CryptoHasher("sha256");
    yield* Stream.runForEach(
      Stream.fromReadableStream({ evaluate: () => opened.body, onError: readFailure }),
      (chunk) =>
        Effect.sync(() => {
          hash.update(chunk);
          tracker.push(chunk);
        }),
    );
    yield* requireCompleteDump(label, fromStdin, tracker.edges());
    return { path: input.file, digest: hash.digest("hex") } satisfies PreparedDump;
  }

  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "lando-dump-")), catch: stageError }),
    releaseStagedDump,
  );
  const path = join(directory, "dump");
  const compression = opened.compression;
  const plaintext =
    compression === "none" ? opened.body : opened.body.pipeThrough(new DecompressionStream(compression));
  const staged = yield* persistVerifiedStream({
    body: Stream.fromReadableStream({
      evaluate: () =>
        plaintext.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
              tracker.push(chunk);
              controller.enqueue(chunk);
            },
          }),
        ),
      onError: (cause) => {
        const source = opened.sourceFailure();
        if (source !== undefined) return readFailure(source.cause);
        if (cause instanceof CommandStdioError) return cause;
        return compression === "none" ? stageError(cause) : decompressError(label, compression);
      },
    }),
    destinationPath: path,
    mode: 0o600,
  }).pipe(Effect.mapError((error) => (error instanceof VerifiedStreamError ? stageError(error) : error)));
  yield* requireCompleteDump(label, fromStdin, tracker.edges());
  return { path, digest: staged.sha256 } satisfies PreparedDump;
});

/**
 * A file export replaces its destination atomically. A directory, named pipe, socket, or device
 * there would be lost or never receive the dump, so refuse it before any database work.
 */
export const ensureExportDestination = (
  path: string,
): Effect.Effect<void, CommandInputValidationError | DataTransferError> =>
  Effect.tryPromise({
    try: () =>
      stat(path).catch((cause: unknown) => {
        const code = errnoCode(cause);
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw cause;
      }),
    catch: (cause) =>
      new DataTransferError({
        message: `Failed to inspect the export destination: ${path}`,
        toEndpoint: "hostPath",
        operation: "inspect",
        remediation: "Check that the destination's directory exists and is readable, then retry the export.",
        cause,
      }),
  }).pipe(
    Effect.flatMap((info) => {
      if (info === undefined || info.isFile()) return Effect.void;
      const directory = info.isDirectory();
      return Effect.fail(
        new CommandInputValidationError({
          message: directory
            ? `Export destination is a directory: ${path}`
            : `Export destination is not a regular file: ${path}`,
          target: "db:export",
          field: "file",
          kind: "arg",
          reason: "constraint",
          remediation: directory
            ? "Pass a file path, for example a dump.sql.gz inside that directory."
            : `To stream into a pipe or another program, pass - and redirect stdout: lando db:export - > ${path}`,
        }),
      );
    }),
  );
