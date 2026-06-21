/**
 * Verified streaming-hash + atomic-persist helper.
 *
 * Pipes a `Stream<Uint8Array>` through a SHA-256 hasher while writing
 * incrementally to a unique temp file on the destination filesystem, verifies
 * the expected checksum/size, then atomically renames onto the destination on
 * success. The temp file is removed on stream failure, checksum mismatch, size
 * mismatch, persistence failure, and `Effect.interrupt`; a verified rename never
 * fires until both checks pass, so an existing destination is never clobbered by
 * a bad fetch.
 *
 * Pure, dependency-injectable streaming hash + persist helper. Stays
 * core-internal until a second consumer (e.g. bulk data moves) justifies
 * lifting it into the SDK. No network I/O and no runtime services.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Data, Effect, Ref, type Scope, Stream } from "effect";

/** Failure raised while persisting/verifying a streamed artifact. */
export class VerifiedStreamError extends Data.TaggedError("VerifiedStreamError")<{
  readonly reason: "checksum" | "size" | "persist";
  readonly message: string;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly expectedSizeBytes?: number;
  readonly actualSizeBytes?: number;
  readonly cause?: unknown;
}> {}

export interface VerifiedStreamResult {
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PersistVerifiedStreamParams<E> {
  readonly body: Stream.Stream<Uint8Array, E>;
  readonly destinationPath: string;
  readonly expectedSha256?: string | undefined;
  readonly expectedSizeBytes?: number | undefined;
  readonly mode?: number | undefined;
  /** Override the temp-suffix generator (tests). */
  readonly randomId?: (() => string) | undefined;
}

export interface CollectVerifiedStreamParams<E> {
  readonly body: Stream.Stream<Uint8Array, E>;
  readonly expectedSha256?: string | undefined;
  readonly expectedSizeBytes?: number | undefined;
}

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path)
    .then(() => undefined)
    .catch(() => undefined);

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
 * Stream `body` into `destinationPath` atomically with checksum/size
 * verification. Requires an ambient `Scope`: a finalizer removes the temp file
 * unless the verified rename committed.
 */
export const persistVerifiedStream = <E>(
  params: PersistVerifiedStreamParams<E>,
): Effect.Effect<VerifiedStreamResult, E | VerifiedStreamError, Scope.Scope> =>
  Effect.gen(function* () {
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
      catch: (cause) =>
        new VerifiedStreamError({
          reason: "persist",
          message: "Failed to create destination directory.",
          cause,
        }),
    });

    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => open(tempPath, "w", params.mode),
        catch: (cause) =>
          new VerifiedStreamError({ reason: "persist", message: "Failed to open temp file.", cause }),
      }),
      (h) => Effect.promise(() => h.close().catch(() => undefined)),
    );

    const hash = createHash("sha256");
    const size = yield* Ref.make(0);

    yield* Stream.runForEach(params.body, (chunk) =>
      Effect.tryPromise({
        try: async () => {
          await handle.write(chunk);
          hash.update(chunk);
        },
        catch: (cause) =>
          new VerifiedStreamError({ reason: "persist", message: "Failed to write artifact bytes.", cause }),
      }).pipe(Effect.zipRight(Ref.update(size, (n) => n + chunk.length))),
    );

    const sizeBytes = yield* Ref.get(size);
    const sha256 = hash.digest("hex");

    const mismatch = verify(sha256, sizeBytes, params.expectedSha256, params.expectedSizeBytes);
    if (mismatch !== undefined) {
      return yield* Effect.fail(mismatch);
    }

    if (params.mode !== undefined) {
      yield* Effect.tryPromise({
        try: () => chmod(tempPath, params.mode as number),
        catch: (cause) =>
          new VerifiedStreamError({ reason: "persist", message: "Failed to set file mode.", cause }),
      });
    }

    yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          await handle.sync().catch(() => undefined);
          await rename(tempPath, params.destinationPath);
        },
        catch: (cause) =>
          new VerifiedStreamError({ reason: "persist", message: "Failed to persist artifact.", cause }),
      }),
    );
    yield* Ref.set(committed, true);

    return { sha256, sizeBytes } satisfies VerifiedStreamResult;
  });

/**
 * Buffer `body` in memory, hashing and counting bytes, and verify the expected
 * checksum/size. No disk is touched. Use only when the caller explicitly wants
 * an in-memory (`memory`) download.
 */
export const collectVerifiedStream = <E>(
  params: CollectVerifiedStreamParams<E>,
): Effect.Effect<VerifiedStreamResult, E | VerifiedStreamError, never> =>
  Effect.gen(function* () {
    const hash = createHash("sha256");
    const size = yield* Ref.make(0);

    yield* Stream.runForEach(params.body, (chunk) =>
      Effect.sync(() => {
        hash.update(chunk);
      }).pipe(Effect.zipRight(Ref.update(size, (n) => n + chunk.length))),
    );

    const sizeBytes = yield* Ref.get(size);
    const sha256 = hash.digest("hex");

    const mismatch = verify(sha256, sizeBytes, params.expectedSha256, params.expectedSizeBytes);
    if (mismatch !== undefined) {
      return yield* Effect.fail(mismatch);
    }

    return { sha256, sizeBytes } satisfies VerifiedStreamResult;
  });
