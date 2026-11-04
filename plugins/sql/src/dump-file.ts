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

/** Keeps the first and last bytes of a dump so completeness can be checked without a second read. */
const trackDumpEdges = () => {
  let head: Uint8Array = new Uint8Array();
  let tail: Uint8Array = new Uint8Array();
  let size = 0;
  return {
    push: (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (head.byteLength < EDGE_BYTES)
        head = concatBytes(head, chunk.subarray(0, EDGE_BYTES - head.byteLength));
      tail =
        chunk.byteLength >= EDGE_BYTES
          ? chunk.slice(-EDGE_BYTES)
          : concatBytes(tail, chunk).slice(-EDGE_BYTES);
    },
    edges: () => ({ head, tail, size }),
  };
};

// Dump tools stamp a header and a completion trailer; a header without its trailer means the tool
// stopped early. Hand-written SQL has neither, so it is never rejected here.
const DUMP_MARKERS = [
  { header: /^-- (?:MySQL|MariaDB) dump /mu, trailer: "-- Dump completed" },
  { header: /^-- PostgreSQL database dump\r?$/mu, trailer: "-- PostgreSQL database dump complete" },
] as const;

export type DumpEdges = { readonly head: Uint8Array; readonly tail: Uint8Array; readonly size: number };

export const dumpIncompleteReason = (edges: DumpEdges): "empty" | "truncated" | undefined => {
  if (edges.size === 0) return "empty";
  const decoder = new TextDecoder();
  const head = decoder.decode(edges.head);
  const marker = DUMP_MARKERS.find((candidate) => candidate.header.test(head));
  if (marker !== undefined && !decoder.decode(edges.tail).includes(marker.trailer)) return "truncated";
  return undefined;
};

const requireCompleteDump = (label: string, fromStdin: boolean, edges: DumpEdges) => {
  const reason = dumpIncompleteReason(edges);
  if (reason === undefined) return Effect.void;
  const source = fromStdin ? "the command feeding stdin" : "the dump file";
  return Effect.fail(
    new SqlDumpIncompleteError({
      message:
        reason === "empty"
          ? `The dump from ${label} is empty.`
          : `The dump from ${label} ends before its completion marker, so the tool that wrote it stopped early.`,
      path: label,
      reason,
      remediation:
        reason === "empty"
          ? `Check that ${source} produced a dump, then retry.`
          : fromStdin
            ? "Recreate the dump and check that the export command succeeded (in bash, set -o pipefail), then retry."
            : "Recreate the dump file and check that the export command succeeded, then retry.",
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

/** Reads the first bytes for magic detection, then hands back a stream that still starts at byte 0. */
const peekCompression = async (source: ReadableStream<Uint8Array>) => {
  const reader = source.getReader();
  const pending: Uint8Array[] = [];
  let prefix: Uint8Array = new Uint8Array();
  while (prefix.byteLength < 4) {
    const next = await reader.read();
    if (next.done) break;
    pending.push(next.value);
    prefix = collectDumpPrefix(next.value, prefix);
  }
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const queued = pending.shift();
      if (queued !== undefined) {
        controller.enqueue(queued);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { compression: detectDumpCompression(prefix), body };
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
  const readFailure = (cause: unknown) =>
    cause instanceof CommandStdioError
      ? cause
      : fromStdin
        ? stageError(cause)
        : dumpNotFound(input.file, input.appRoot, dumpMissKind(cause));
  const opened = yield* Effect.tryPromise({
    try: () =>
      peekCompression(
        input.stdin === undefined ? Bun.file(input.file).stream() : Stream.toReadableStream(input.stdin),
      ),
    catch: readFailure,
  });
  const tracker = trackDumpEdges();

  if (opened.compression === "none" && !fromStdin) {
    const hash = new Bun.CryptoHasher("sha256");
    yield* Effect.tryPromise({
      try: async () => {
        for await (const chunk of opened.body) {
          hash.update(chunk);
          tracker.push(chunk);
        }
      },
      catch: readFailure,
    });
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
      onError: (cause) =>
        cause instanceof CommandStdioError
          ? cause
          : compression === "none"
            ? stageError(cause)
            : decompressError(label, compression),
      releaseLockOnEnd: true,
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
export const ensureExportDestination = (path: string): Effect.Effect<void, CommandInputValidationError> =>
  Effect.promise(() => stat(path).catch(() => undefined)).pipe(
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
