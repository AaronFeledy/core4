import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, stat } from "node:fs/promises";
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
import { makeMongoArchiveTracker } from "./mongo-archive.ts";

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
// The tail keeps one byte before its window, so a window that starts mid-line can be detected.
const TAIL_BYTES = EDGE_BYTES + 1;

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};

const lastBytes = (bytes: Uint8Array, limit = EDGE_BYTES): Uint8Array =>
  bytes.byteLength > limit ? bytes.slice(-limit) : bytes;

/** Drops a partial first line, unless the tail reaches back to the start of the dump. */
const wholeLineTail = (tail: Uint8Array): Uint8Array => {
  if (tail.byteLength <= EDGE_BYTES) return tail;
  const lineBreak = tail.indexOf(0x0a);
  return lineBreak === -1 ? new Uint8Array() : tail.subarray(lineBreak + 1);
};

const isAsciiWhitespace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/**
 * Keeps the first bytes of a dump and the last bytes before any trailing whitespace, and follows
 * mongodump archive framing, so completeness is checked during the single read without buffering.
 */
const trackDumpEdges = () => {
  let head: Uint8Array = new Uint8Array();
  let tail: Uint8Array = new Uint8Array();
  let trailingWhitespace: Uint8Array = new Uint8Array();
  let size = 0;
  // A non-archive fails the magic check on its first bytes and then ignores the rest.
  const archive = makeMongoArchiveTracker();
  return {
    push: (chunk: Uint8Array) => {
      size += chunk.byteLength;
      archive.push(chunk);
      if (head.byteLength < EDGE_BYTES)
        head = concatBytes(head, chunk.subarray(0, EDGE_BYTES - head.byteLength));
      const last = chunk.findLastIndex((byte) => !isAsciiWhitespace(byte));
      if (last === -1) {
        trailingWhitespace = lastBytes(concatBytes(trailingWhitespace, chunk));
        return;
      }
      const content = chunk.subarray(0, last + 1);
      tail =
        content.byteLength >= TAIL_BYTES
          ? content.slice(-TAIL_BYTES)
          : lastBytes(concatBytes(concatBytes(tail, trailingWhitespace), content), TAIL_BYTES);
      trailingWhitespace = lastBytes(chunk.subarray(last + 1));
    },
    edges: () => ({ head, tail, size, archiveComplete: archive.complete() }),
  };
};

const MONGO_ARCHIVE_MAGIC = [0x6d, 0xe2, 0x99, 0x81] as const;

const startsWithBytes = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

// Dump tools stamp a header near the start and a completion trailer at the end; a header without
// its trailer means the tool stopped early. Trailers must be whole lines, so a SQL string that
// happens to contain one doesn't count. Hand-written SQL has no header and is never rejected here.
const SQL_DUMP_FORMATS: ReadonlyArray<{
  readonly header: (head: string) => boolean;
  readonly complete: (tail: string) => boolean;
}> = [
  {
    // mysqldump and mariadb-dump end with "-- Dump completed" (plus " on <date>" unless skipped).
    header: (head) => /^-- (?:MySQL|MariaDB) dump /mu.test(head),
    complete: (tail) => /(?:^|\n)-- Dump completed(?: on [^\n]*)?\r?$/u.test(tail),
  },
  {
    // pg_dump's trailer may be followed by \unrestrict and comment lines.
    header: (head) => /^-- PostgreSQL database dump\r?$/mu.test(head),
    // The footer is a three-line comment block, so a single COPY data row can't impersonate it.
    complete: (tail) => /(?:^|\n)--\r?\n-- PostgreSQL database dump complete\r?\n--\r?(?:\n|$)/u.test(tail),
  },
];

type DumpEdges = ReturnType<ReturnType<typeof trackDumpEdges>["edges"]>;

const dumpIncompleteReason = (edges: DumpEdges): "empty" | "truncated" | undefined => {
  if (edges.size === 0) return "empty";
  // A mongodump archive ends in a terminator after every block, so its framing, not its last
  // bytes, shows whether every collection finished.
  if (startsWithBytes(edges.head, MONGO_ARCHIVE_MAGIC))
    return edges.archiveComplete ? undefined : "truncated";
  const decoder = new TextDecoder();
  const head = decoder.decode(edges.head);
  const format = SQL_DUMP_FORMATS.find((candidate) => candidate.header(head));
  if (format === undefined) return undefined;
  return format.complete(decoder.decode(wholeLineTail(edges.tail))) ? undefined : "truncated";
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

const stageError =
  (stagingDir: string) =>
  (cause: unknown): DataTransferError =>
    new DataTransferError({
      message: `Failed to stage the dump in ${stagingDir}.`,
      toEndpoint: "hostPath",
      operation: "stage",
      remediation: `Check that ${stagingDir} is writable and has room for the uncompressed dump, then retry.`,
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

type DumpSourceReader = {
  readonly read: () => Promise<
    | { readonly done: true; readonly value?: Uint8Array | undefined }
    | { readonly done: false; readonly value: Uint8Array }
  >;
  readonly cancel: (reason?: unknown) => Promise<void>;
};

/**
 * Reads the first bytes for magic detection, then hands back a stream that still starts at byte 0.
 * `sourceFailure` remembers a read error so it isn't mistaken for corrupt compression after it
 * passes through a decompressor.
 */
const peekCompression = async (reader: DumpSourceReader) => {
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
  while (prefix.byteLength < 4) {
    const next = await read();
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
 * stdin or compressed input in an owner-only file under `stagingDir` that lives until the
 * surrounding scope closes, hashes the plaintext, and rejects an empty or truncated dump. An uncompressed file is
 * hashed in place, never copied.
 */
export const prepareImportDump = Effect.fn("Sql.prepareImportDump")(function* (input: {
  readonly file: string;
  readonly appRoot: string;
  /** Lando's transfer staging directory; dumps can be large, so not the OS temp directory. */
  readonly stagingDir: string;
  readonly stdin?: Stream.Stream<Uint8Array, CommandStdioError>;
}) {
  const stageFailure = stageError(input.stagingDir);
  const fromStdin = input.stdin !== undefined;
  const label = fromStdin ? "stdin" : input.file;
  const readFailure = (cause: unknown) => {
    if (cause instanceof CommandStdioError) return cause;
    if (fromStdin) return stageFailure(cause);
    return dumpNotFound(input.file, input.appRoot, dumpMissKind(cause));
  };
  // The scope owns the source reader: interruption at any point, even mid-peek, waits for the
  // source to cancel (closing the file or releasing stdin) before the import moves on.
  const source =
    input.stdin === undefined ? Bun.file(input.file).stream() : Stream.toReadableStream(input.stdin);
  const reader = yield* Effect.acquireRelease(
    Effect.sync(() => source.getReader()),
    (owned) => Effect.promise(() => owned.cancel().catch(() => undefined)),
  );
  const opened = yield* Effect.tryPromise({ try: () => peekCompression(reader), catch: readFailure });
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
    Effect.tryPromise({
      try: async () => {
        await mkdir(input.stagingDir, { recursive: true, mode: 0o700 });
        return await mkdtemp(join(input.stagingDir, "sql-dump-"));
      },
      catch: stageFailure,
    }),
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
        return compression === "none" ? stageFailure(cause) : decompressError(label, compression);
      },
    }),
    destinationPath: path,
    mode: 0o600,
  }).pipe(Effect.mapError((error) => (error instanceof VerifiedStreamError ? stageFailure(error) : error)));
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
      stat(path).catch(async (cause: unknown) => {
        const code = errnoCode(cause);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
        // A dangling symlink still exists, and the export would replace the link itself.
        return lstat(path).catch(() => undefined);
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
      const refusal = info.isDirectory()
        ? {
            message: `Export destination is a directory: ${path}`,
            remediation: "Pass a file path, for example a dump.sql.gz inside that directory.",
          }
        : info.isSymbolicLink()
          ? {
              message: `Export destination is a symbolic link to a missing file: ${path}`,
              remediation: "Point the link at an existing file, remove it, or pass another path.",
            }
          : {
              message: `Export destination is not a regular file: ${path}`,
              remediation: `To stream into a pipe or another program, pass - and redirect stdout: lando db:export - > ${path}`,
            };
      return Effect.fail(
        new CommandInputValidationError({
          ...refusal,
          target: "db:export",
          field: "file",
          kind: "arg",
          reason: "constraint",
        }),
      );
    }),
  );
