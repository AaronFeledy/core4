import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import {
  CommandStdioError,
  DataTransferError,
  SqlDumpCompressionError,
  type SqlDumpIncompleteError,
  SqlDumpNotFoundError,
  errnoCode,
} from "@lando/sdk/errors";
import { VerifiedStreamError, persistVerifiedStream } from "@lando/sdk/verified-stream";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, type Scope, Stream } from "effect";

import {
  type DumpCompression,
  collectDumpPrefix,
  detectDumpCompression,
  releaseStagedDump,
} from "./compression.ts";
import { type DumpCompletenessRule, trackDumpCompleteness } from "./dump-completeness.ts";
import { dumpTransferError } from "./dump-transfer-error.ts";

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

const decompressError = (label: string, compression: Exclude<DumpCompression, "none">, cause: unknown) =>
  new SqlDumpCompressionError({
    message: `Failed to decompress dump: ${label}`,
    path: label,
    compression,
    operation: "decompress",
    cause,
    remediation: `The ${compression} data is corrupt or cut short. Recreate the dump, then retry the import.`,
  });

type DumpSourceReader = {
  readonly read: () => Promise<
    | { readonly done: true; readonly value?: Uint8Array | undefined }
    | { readonly done: false; readonly value: Uint8Array }
  >;
  readonly cancel: (reason?: unknown) => Promise<void>;
};

type DumpReadError = CommandStdioError | DataTransferError;

/**
 * Reads the first bytes for magic detection, then hands back a stream that still starts at byte 0.
 * `sourceFailure` remembers a read error so it isn't mistaken for corrupt compression after it
 * passes through a decompressor.
 */
const peekCompression = async (reader: DumpSourceReader, onReadError: (cause: unknown) => DumpReadError) => {
  let sourceFailure: { readonly cause: DumpReadError } | undefined;
  const read = async () => {
    try {
      return await reader.read();
    } catch (cause) {
      const error = onReadError(cause);
      sourceFailure = { cause: error };
      throw error;
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
  /** Owner-only access on Windows, where file modes set no ACL. */
  readonly privateFileAccess: PrivateFileAccess;
  readonly completeness: DumpCompletenessRule | undefined;
  readonly stdin?: Stream.Stream<Uint8Array, CommandStdioError>;
}): Effect.fn.Return<
  PreparedDump,
  CommandStdioError | DataTransferError | SqlDumpCompressionError | SqlDumpIncompleteError,
  Scope.Scope
> {
  const stageFailure = (cause: unknown) => dumpTransferError("stage", input.stagingDir, cause);
  let privacyFailure: DataTransferError | undefined;
  const privateAccessFailure = (path: string, cause: unknown) =>
    new DataTransferError({
      operation: "stage",
      toEndpoint: "hostPath",
      message: `Failed to secure private access to the dump staging path: ${path}`,
      cause,
      remediation: "Check owner-only access and ACL settings on the dump staging path, then retry.",
    });
  const makePrivate = async (path: string): Promise<void> => {
    await input.privateFileAccess.enforce(path);
    await input.privateFileAccess.verify(path);
  };
  const fromStdin = input.stdin !== undefined;
  const label = fromStdin ? "stdin" : input.file;
  const readFailure = (cause: unknown): DumpReadError => {
    if (cause instanceof CommandStdioError || cause instanceof DataTransferError) return cause;
    return dumpTransferError("read", label, cause);
  };
  // The scope owns the source reader: interruption at any point, even mid-peek, waits for the
  // source to cancel (closing the file or releasing stdin) before the import moves on.
  const reader = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        (input.stdin === undefined
          ? Bun.file(input.file).stream()
          : Stream.toReadableStream(input.stdin)
        ).getReader(),
      catch: readFailure,
    }),
    (owned) => Effect.promise(() => owned.cancel().catch(() => undefined)),
  );
  const opened = yield* Effect.tryPromise({
    try: () => peekCompression(reader, readFailure),
    catch: readFailure,
  });
  const tracker = trackDumpCompleteness(input.completeness);

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
    yield* tracker.requireComplete(label, fromStdin);
    return { path: input.file, digest: hash.digest("hex") } satisfies PreparedDump;
  }

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(input.stagingDir, { recursive: true, mode: 0o700 });
      await chmod(input.stagingDir, 0o700);
    },
    catch: stageFailure,
  });
  yield* Effect.tryPromise({
    try: () => makePrivate(input.stagingDir),
    catch: (cause) => privateAccessFailure(input.stagingDir, cause),
  });
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(input.stagingDir, "sql-dump-")), catch: stageFailure }),
    releaseStagedDump,
  );
  yield* Effect.tryPromise({
    try: () => makePrivate(directory),
    catch: (cause) => privateAccessFailure(directory, cause),
  });
  const path = join(directory, "dump");
  const compression = opened.compression;
  const plaintext =
    compression === "none"
      ? opened.body
      : yield* Effect.try({
          try: () => opened.body.pipeThrough(new DecompressionStream(compression)),
          catch: (cause) => decompressError(label, compression, cause),
        });
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
        if (source !== undefined) return source.cause;
        return compression === "none" ? readFailure(cause) : decompressError(label, compression, cause);
      },
    }),
    destinationPath: path,
    mode: 0o600,
    beforeWrite: async (path) => {
      try {
        await makePrivate(path);
      } catch (cause) {
        privacyFailure = privateAccessFailure(path, cause);
        throw privacyFailure;
      }
    },
  }).pipe(
    mapFailures((error) =>
      error instanceof VerifiedStreamError
        ? privacyFailure === undefined
          ? dumpTransferError("persist", path, error)
          : privacyFailure
        : error,
    ),
  );
  yield* tracker.requireComplete(label, fromStdin);
  return { path, digest: staged.sha256 } satisfies PreparedDump;
});
