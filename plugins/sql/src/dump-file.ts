import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Stream } from "effect";

import {
  CommandStdioError,
  DataTransferError,
  SqlDumpCompressionError,
  SqlDumpNotFoundError,
  errnoCode,
} from "@lando/sdk/errors";
import { VerifiedStreamError, persistVerifiedStream } from "@lando/sdk/verified-stream";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

import {
  type DumpCompression,
  collectDumpPrefix,
  detectDumpCompression,
  releaseStagedDump,
} from "./compression.ts";
import { type DumpCompletenessRule, trackDumpCompleteness } from "./dump-completeness.ts";

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
  /** Owner-only access on Windows, where file modes set no ACL. */
  readonly privateFileAccess: PrivateFileAccess;
  readonly completeness: DumpCompletenessRule | undefined;
  readonly stdin?: Stream.Stream<Uint8Array, CommandStdioError>;
}) {
  const stageFailure = stageError(input.stagingDir);
  const makePrivate = async (path: string): Promise<void> => {
    await input.privateFileAccess.enforce(path);
    await input.privateFileAccess.verify(path);
  };
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

  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(input.stagingDir, { recursive: true, mode: 0o700 });
        await chmod(input.stagingDir, 0o700);
        await makePrivate(input.stagingDir);
        const created = await mkdtemp(join(input.stagingDir, "sql-dump-"));
        await makePrivate(created);
        return created;
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
    beforeWrite: makePrivate,
  }).pipe(Effect.mapError((error) => (error instanceof VerifiedStreamError ? stageFailure(error) : error)));
  yield* tracker.requireComplete(label, fromStdin);
  return { path, digest: staged.sha256 } satisfies PreparedDump;
});
