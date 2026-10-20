/**
 * `@lando/sdk/verified-stream` — stream -> SHA-256 persist helper.
 *
 * Regular-file destinations write through a unique temp file and atomically
 * rename onto the target after checksum/size checks. An existing destination
 * that is not a regular file (character device, FIFO, socket) is written in
 * place: no temp sibling, no rename. `/dev/stdout`, `/dev/stderr`, and
 * `/dev/fd/N` write the inherited descriptor instead of reopening the path,
 * because an anonymous pipe cannot be reopened. The temp file is removed on
 * stream failure, checksum mismatch, size mismatch, persistence failure, and
 * `Effect.interrupt` for the atomic path; a verified rename never fires until
 * both checks pass, so an existing regular file is never clobbered by a bad
 * fetch. Direct writes to special files cannot unwrite partial bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, writeSync } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect, Ref, Schema, type Scope, Stream } from "effect";

/** Failure raised while persisting/verifying a streamed artifact. */
export class VerifiedStreamError extends Schema.TaggedError<VerifiedStreamError>()("VerifiedStreamError", {
  reason: Schema.Literals(["checksum", "size", "persist"]),
  message: Schema.String,
  expectedSha256: Schema.optionalKey(Schema.String),
  actualSha256: Schema.optionalKey(Schema.String),
  expectedSizeBytes: Schema.optionalKey(Schema.Number),
  actualSizeBytes: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export interface VerifiedStreamResult {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PersistVerifiedStreamParams<E, R = never> {
  readonly body: Stream.Stream<Uint8Array, E, R>;
  readonly destinationPath: string;
  readonly expectedSha256?: string | undefined;
  readonly expectedSizeBytes?: number | undefined;
  readonly mode?: number | undefined;
  /** Override the temp-suffix generator (tests). */
  readonly randomId?: (() => string) | undefined;
}

export interface CollectVerifiedStreamParams<E, R = never> {
  readonly body: Stream.Stream<Uint8Array, E, R>;
  readonly expectedSha256?: string | undefined;
  readonly expectedSizeBytes?: number | undefined;
}

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path)
    .then(() => undefined)
    .catch(() => undefined);

const persistError = (message: string, cause: unknown): VerifiedStreamError =>
  new VerifiedStreamError({ reason: "persist", message, cause });

const existingDestination = (path: string) =>
  Effect.promise(() =>
    stat(path).then(
      (info) => info,
      () => undefined,
    ),
  );

const inheritedWriteFd = (path: string): number | undefined => {
  if (path === "/dev/stdout") return 1;
  if (path === "/dev/stderr") return 2;
  const match = /^(?:\/dev\/fd|\/proc\/self\/fd)\/(\d+)$/u.exec(path);
  if (match === null) return undefined;
  const fd = Number(match[1]);
  return Number.isInteger(fd) ? fd : undefined;
};

const writeAllToFd = (fd: number, chunk: Uint8Array): void => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    offset += writeSync(fd, chunk.subarray(offset));
  }
};

const writeHashedBody = <E, R>(
  writeChunk: (chunk: Uint8Array) => Promise<unknown>,
  body: Stream.Stream<Uint8Array, E, R>,
  hash: ReturnType<typeof createHash>,
  size: Ref.Ref<number>,
): Effect.Effect<void, E | VerifiedStreamError, R> =>
  Stream.runForEach(body, (chunk) =>
    Effect.tryPromise({
      try: async () => {
        await writeChunk(chunk);
        hash.update(chunk);
      },
      catch: (cause) => persistError("Failed to write artifact bytes.", cause),
    }).pipe(Effect.andThen(Ref.update(size, (n) => n + chunk.length))),
  );

const verify = (
  sha256: string,
  sizeBytes: number,
  expectedSha256: string | undefined,
  expectedSizeBytes: number | undefined,
): VerifiedStreamError | undefined => {
  if (expectedSizeBytes !== undefined && sizeBytes !== expectedSizeBytes) {
    return new VerifiedStreamError({
      reason: "size",
      message: `Downloaded size ${sizeBytes} does not match expected ${expectedSizeBytes}.`,
      expectedSizeBytes,
      actualSizeBytes: sizeBytes,
    });
  }
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    return new VerifiedStreamError({
      reason: "checksum",
      message: "Downloaded checksum does not match the expected SHA-256.",
      expectedSha256,
      actualSha256: sha256,
    });
  }
  return undefined;
};

/**
 * Stream `body` into `destinationPath` with checksum/size verification.
 * Regular files use a temp sibling and atomic rename. Existing non-regular
 * destinations (character devices, FIFOs, sockets) are written in place.
 * Stdout, stderr, and `/dev/fd/N` write the inherited fd and never close it.
 * Requires an ambient `Scope`: a finalizer removes the temp file unless the
 * verified rename committed. Direct writes never unlink the destination.
 */
export const persistVerifiedStream = Effect.fn("VerifiedStream.persist")(function* <E, R>(
  params: PersistVerifiedStreamParams<E, R>,
): Effect.fn.Return<VerifiedStreamResult, E | VerifiedStreamError, Scope.Scope | R> {
  const inheritedFd = inheritedWriteFd(params.destinationPath);
  const existing = inheritedFd === undefined ? yield* existingDestination(params.destinationPath) : undefined;
  const direct = existing !== undefined && !existing.isFile() && !existing.isDirectory();
  const hash = createHash("sha256");
  const size = yield* Ref.make(0);

  if (inheritedFd !== undefined || direct) {
    if (inheritedFd !== undefined) {
      yield* writeHashedBody(
        (chunk) => Promise.resolve(writeAllToFd(inheritedFd, chunk)),
        params.body,
        hash,
        size,
      );
    } else {
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(params.destinationPath, constants.O_WRONLY),
          catch: (cause) => persistError("Failed to open destination.", cause),
        }),
        (h) => Effect.promise(() => h.close().catch(() => undefined)),
      );
      yield* writeHashedBody((chunk) => handle.write(chunk), params.body, hash, size);
      yield* Effect.promise(() => handle.sync().catch(() => undefined));
    }
    const sizeBytes = yield* Ref.get(size);
    const sha256 = hash.digest("hex");
    const mismatch = verify(sha256, sizeBytes, params.expectedSha256, params.expectedSizeBytes);
    if (mismatch !== undefined) return yield* Effect.fail(mismatch);
    return { sha256, sizeBytes } satisfies VerifiedStreamResult;
  }

  const tempPath = `${params.destinationPath}.tmp-${params.randomId?.() ?? randomUUID()}`;
  const committed = yield* Ref.make(false);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(committed))) {
        yield* Effect.promise(() => removeIfPresent(tempPath));
      }
    }),
  );

  yield* Effect.tryPromise({
    try: () => mkdir(dirname(params.destinationPath), { recursive: true }),
    catch: (cause) => persistError("Failed to create destination directory.", cause),
  });

  const handle = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => open(tempPath, "w", params.mode),
      catch: (cause) => persistError("Failed to open temp file.", cause),
    }),
    (h) => Effect.promise(() => h.close().catch(() => undefined)),
  );

  yield* writeHashedBody((chunk) => handle.write(chunk), params.body, hash, size);

  const sizeBytes = yield* Ref.get(size);
  const sha256 = hash.digest("hex");

  const mismatch = verify(sha256, sizeBytes, params.expectedSha256, params.expectedSizeBytes);
  if (mismatch !== undefined) {
    return yield* Effect.fail(mismatch);
  }

  if (params.mode !== undefined) {
    yield* Effect.tryPromise({
      try: () => chmod(tempPath, params.mode as number),
      catch: (cause) => persistError("Failed to set file mode.", cause),
    });
  }

  yield* Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        await handle.sync().catch(() => undefined);
        await handle.close();
        await rename(tempPath, params.destinationPath);
      },
      catch: (cause) => persistError("Failed to persist artifact.", cause),
    }),
  );
  yield* Ref.set(committed, true);

  return { sha256, sizeBytes } satisfies VerifiedStreamResult;
});

/**
 * Buffer `body` in memory, hashing and counting bytes, and verify the expected
 * checksum/size. No disk is touched. Use only when the caller explicitly wants
 * an in-memory download.
 */
export const collectVerifiedStream = Effect.fn("VerifiedStream.collect")(function* <E, R>(
  params: CollectVerifiedStreamParams<E, R>,
): Effect.fn.Return<VerifiedStreamResult, E | VerifiedStreamError, R> {
  const hash = createHash("sha256");
  const size = yield* Ref.make(0);

  yield* Stream.runForEach(params.body, (chunk) =>
    Effect.sync(() => {
      hash.update(chunk);
    }).pipe(Effect.andThen(Ref.update(size, (n) => n + chunk.length))),
  );

  const sizeBytes = yield* Ref.get(size);
  const sha256 = hash.digest("hex");

  const mismatch = verify(sha256, sizeBytes, params.expectedSha256, params.expectedSizeBytes);
  if (mismatch !== undefined) {
    return yield* Effect.fail(mismatch);
  }

  return { sha256, sizeBytes } satisfies VerifiedStreamResult;
});
