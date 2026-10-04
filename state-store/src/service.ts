// Root resolution uses `@lando/paths` directly so the default layer requires no
// `PathsService` dependency that would be unavailable as a sibling layer.

import { rename, stat } from "node:fs/promises";

import { Clock, Effect, Layer } from "effect";

import { StateStoreError, isErrnoCode } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import {
  type StateBucket,
  type StateBucketSpec,
  type StateMigrator,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";

import { writeFileAtomicScoped } from "./atomic.ts";
import { type DecodedFrame, decodeFrame, encodeFrame, isCustomCodec, makeSchemaCodec } from "./codec.ts";
import { withAdvisoryLockUsing } from "./lock.ts";
import { resolveStatePath } from "./paths.ts";
import { type PrivateFileAccess, PrivateFileAccessService } from "./private-file-access.ts";

const ioError = (operation: string, path: string, cause: unknown): StateStoreError =>
  new StateStoreError({ reason: "io", operation, path, cause });

const decodeError = (operation: string, path: string, cause: unknown): StateStoreError =>
  new StateStoreError({
    reason: "decode",
    operation,
    path,
    cause,
    remediation: "The durable state file is corrupt; remove it or restore a backup.",
  });

const versionError = (operation: string, path: string, cause: unknown): StateStoreError =>
  new StateStoreError({
    reason: "version",
    operation,
    path,
    cause,
    remediation: "The durable state version could not be migrated.",
  });

const buildBucket = <A, I>(
  spec: StateBucketSpec<A, I>,
  file: string,
  privateFileAccess: PrivateFileAccess,
): StateBucket<A> => {
  const path = file as AbsolutePath;
  const onCorrupt = spec.onCorrupt ?? "quarantine";
  const lockMode = spec.lock ?? "none";
  const fallback: A | null = spec.default ?? null;
  const schema = makeSchemaCodec(spec.schema);
  const codec = spec.codec;
  const writeOptions = {
    ...(spec.mode === undefined ? {} : { mode: spec.mode }),
    privateFileAccess: privateFileAccess.enforce,
  };

  const readBytes = Effect.tryPromise({
    try: () => Bun.file(file).bytes(),
    catch: (cause) => ioError("get", file, cause),
  }).pipe(
    Effect.catchIf(
      (error) => isErrnoCode(error.cause, "ENOENT"),
      () => Effect.succeed<Uint8Array | null>(null),
    ),
  );

  const quarantine = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.promise(() => rename(file, `${file}.corrupt-${now}`).catch(() => undefined)),
    ),
  );

  const handleCorrupt = (cause: unknown): Effect.Effect<A | null, StateStoreError> => {
    if (onCorrupt === "fail") return Effect.fail(decodeError("get", file, cause));
    const recover = Effect.succeed<A | null>(fallback);
    return onCorrupt === "quarantine" ? quarantine.pipe(Effect.andThen(recover)) : recover;
  };

  const applyVersionMismatch = (
    payload: unknown,
    fromVersion: number,
  ): Effect.Effect<A | null, StateStoreError> => {
    if (spec.onVersionMismatch === undefined || spec.onVersionMismatch === "discard") {
      return Effect.succeed(fallback);
    }
    const migrate = spec.onVersionMismatch as StateMigrator<A>;
    return Effect.try({
      try: () => migrate(payload, fromVersion),
      catch: (cause) => versionError("get", file, cause),
    });
  };

  const decodeValue = (payload: unknown): Effect.Effect<A | null, StateStoreError> =>
    schema.decode(payload).pipe(
      Effect.map((value): A | null => value),
      Effect.catch((cause) => handleCorrupt(cause)),
    );

  const get: Effect.Effect<A | null, StateStoreError> = readBytes.pipe(
    Effect.flatMap((bytes) => {
      if (bytes === null) return Effect.succeed(fallback);
      let frame: DecodedFrame;
      try {
        frame = decodeFrame(codec, bytes);
      } catch (cause) {
        return handleCorrupt(
          cause instanceof Error ? cause : new Error("State codec decode failed.", { cause }),
        );
      }
      // A custom codec is unversioned (`version: null`); framed codecs carry the
      // stamped version and route a mismatch through `onVersionMismatch`.
      if (frame.version !== null && frame.version !== spec.version) {
        return applyVersionMismatch(frame.payload, frame.version);
      }
      return decodeValue(frame.payload);
    }),
    Effect.withSpan("StateBucket.get"),
  );

  const writeValue = (value: A): Effect.Effect<void, StateStoreError> => {
    if (isCustomCodec(codec)) {
      return Effect.try({
        try: () => codec.encode(value),
        catch: (cause) => decodeError("set", file, cause),
      }).pipe(
        Effect.flatMap((body) =>
          writeFileAtomicScoped(file, body, writeOptions).pipe(
            Effect.mapError((cause) => ioError("set", file, cause)),
          ),
        ),
      );
    }
    return schema.encode(value).pipe(
      Effect.mapError((cause) => decodeError("set", file, cause)),
      Effect.flatMap((encoded) => {
        const body = encodeFrame(codec, spec.version, encoded, value);
        return writeFileAtomicScoped(file, body, writeOptions).pipe(
          Effect.mapError((cause) => ioError("set", file, cause)),
        );
      }),
    );
  };

  const lock = <B, E>(
    operation: string,
    effect: Effect.Effect<B, E>,
  ): Effect.Effect<B, E | StateStoreError> =>
    lockMode === "advisory" ? withAdvisoryLockUsing(privateFileAccess)(file, operation, effect) : effect;

  const modify = Effect.fn("StateBucket.modify")(
    <B>(f: (cur: A | null) => readonly [B, A]): Effect.Effect<B, StateStoreError> =>
      lock(
        "modify",
        get.pipe(
          Effect.flatMap((current) => {
            const [result, next] = f(current);
            return writeValue(next).pipe(Effect.as(result));
          }),
        ),
      ),
  );

  const update = Effect.fn("StateBucket.update")(
    (f: (cur: A | null) => A): Effect.Effect<A, StateStoreError> =>
      lock(
        "update",
        get.pipe(
          Effect.flatMap((current) => {
            const next = f(current);
            return writeValue(next).pipe(Effect.as(next));
          }),
        ),
      ),
  );

  const set = Effect.fn("StateBucket.set")(
    (value: A): Effect.Effect<void, StateStoreError> => lock("set", writeValue(value)),
  );

  const remove: Effect.Effect<void, StateStoreError> = lock(
    "remove",
    Effect.tryPromise({
      try: () => Bun.file(file).delete(),
      catch: (cause) => ioError("remove", file, cause),
    }).pipe(
      Effect.catchIf(
        (error) => isErrnoCode(error.cause, "ENOENT"),
        () => Effect.void,
      ),
    ),
  );

  const exists: Effect.Effect<boolean, StateStoreError> = Effect.tryPromise({
    try: () => stat(file),
    catch: (cause) => ioError("exists", file, cause),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => isErrnoCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  );

  return {
    path,
    get,
    set,
    update,
    modify,
    remove: remove.pipe(Effect.withSpan("StateBucket.remove")),
    exists: exists.pipe(Effect.withSpan("StateBucket.exists")),
  } satisfies StateBucket<A>;
};

/**
 * Build the {@link StateStoreShape}: `open` resolves and containment-checks a
 * bucket's path (no read/write IO) and returns a {@link StateBucket} closure.
 */
export const makeStateStore = (options: {
  readonly privateFileAccess: PrivateFileAccess;
}): StateStoreShape =>
  StateStore.of({
    open: Effect.fn("StateStore.open")(
      <A, I>(spec: StateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
        resolveStatePath(spec.root, spec.namespace, spec.key, "open").pipe(
          Effect.map((resolved) => buildBucket(spec, resolved.file, options.privateFileAccess)),
        ),
    ),
    withLock: Effect.fn("StateStore.withLock")(<A, E>(key: string, body: Effect.Effect<A, E>) =>
      resolveStatePath("userData", "operation-locks", key, "withLock").pipe(
        Effect.flatMap((resolved) =>
          withAdvisoryLockUsing(options.privateFileAccess)(resolved.file, "withLock", body),
        ),
      ),
    ),
  });

export const layerWithPrivateFileAccess: Layer.Layer<StateStore, never, PrivateFileAccessService> =
  Layer.effect(
    StateStore,
    Effect.map(PrivateFileAccessService, (privateFileAccess) =>
      makeStateStore({
        privateFileAccess,
      }),
    ),
  );

export const layer: Layer.Layer<StateStore> = layerWithPrivateFileAccess.pipe(
  Layer.provide(PrivateFileAccessService.layer),
);
