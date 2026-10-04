import { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { StateBucket, StateBucketSpec } from "@lando/sdk/services";
import { Clock, Effect } from "effect";
import { type DecodedFrame, decodeFrame, encodeFrame, isCustomCodec, makeSchemaCodec } from "./codec.ts";

export interface StateBucketBackend {
  readonly readBytes: (file: string, operation: string) => Effect.Effect<Uint8Array | null, StateStoreError>;
  // Keep operation attribution separate from write options at the IO seam.
  readonly writeBytes: (
    file: string,
    body: Uint8Array | string,
    operation: string,
    options: { readonly mode?: number },
  ) => Effect.Effect<void, StateStoreError>;
  readonly remove: (file: string) => Effect.Effect<void, StateStoreError>;
  readonly exists: (file: string) => Effect.Effect<boolean, StateStoreError>;
  readonly quarantine: (file: string, nowMillis: number) => Effect.Effect<void>;
  readonly withLock: <A, E>(
    file: string,
    operation: string,
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | StateStoreError>;
}

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

export const buildStateBucket = <A, I>(
  spec: StateBucketSpec<A, I>,
  file: string,
  backend: StateBucketBackend,
): StateBucket<A> => {
  // The caller has already resolved and containment-checked this absolute path.
  const path = file as AbsolutePath;
  const onCorrupt = spec.onCorrupt ?? "quarantine";
  const lockMode = spec.lock ?? "none";
  const fallback: A | null = spec.default ?? null;
  const schema = makeSchemaCodec(spec.schema);
  const codec = spec.codec;
  const writeOptions = {
    ...(spec.mode === undefined ? {} : { mode: spec.mode }),
  };
  const quarantine = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => backend.quarantine(file, now)));

  const handleCorrupt = (cause: unknown): Effect.Effect<A | null, StateStoreError> => {
    switch (onCorrupt) {
      case "fail":
        return Effect.fail(decodeError("get", file, cause));
      case "quarantine":
        return quarantine.pipe(Effect.andThen(Effect.succeed<A | null>(fallback)));
      case "discard":
        return Effect.succeed<A | null>(fallback);
      default:
        return onCorrupt satisfies never;
    }
  };

  const applyVersionMismatch = (
    payload: unknown,
    fromVersion: number,
  ): Effect.Effect<A | null, StateStoreError> => {
    const migrate = spec.onVersionMismatch;
    if (migrate === undefined || migrate === "discard") {
      return Effect.succeed(fallback);
    }
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

  const get: Effect.Effect<A | null, StateStoreError> = backend.readBytes(file, "get").pipe(
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
      }).pipe(Effect.flatMap((body) => backend.writeBytes(file, body, "set", writeOptions)));
    }
    return schema.encode(value).pipe(
      Effect.mapError((cause) => decodeError("set", file, cause)),
      Effect.flatMap((encoded) => {
        const body = encodeFrame(codec, spec.version, encoded, value);
        return backend.writeBytes(file, body, "set", writeOptions);
      }),
    );
  };

  const lock = <B, E>(
    operation: string,
    effect: Effect.Effect<B, E>,
  ): Effect.Effect<B, E | StateStoreError> =>
    lockMode === "advisory" ? backend.withLock(file, operation, effect) : effect;

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

  const remove = lock("remove", backend.remove(file));
  const exists = backend.exists(file);

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
