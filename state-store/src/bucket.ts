import { mapFailures } from "@lando/sdk/command-result";
import { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { StateBucket, StateBucketSpec, StateTransition, StateWrite } from "@lando/sdk/services";
import { planTransition } from "@lando/sdk/transitions";
import { Clock, Effect } from "effect";
import { FrameDecodeError, encodeFrame, isCustomCodec, makeSchemaCodec, readFrame } from "./codec.ts";
import { newerStateVersionError } from "./newer-version.ts";

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

export const buildStateBucket = <A, I>(
  spec: StateBucketSpec<A, I>,
  file: string,
  backend: StateBucketBackend,
  writer?: string,
): StateBucket<A> => {
  // The caller has already resolved and containment-checked this absolute path.
  const path = file as AbsolutePath;
  const onCorrupt = spec.onCorrupt ?? "quarantine";
  const lockMode = spec.lock ?? "none";
  const fallback: A | null = spec.default ?? null;
  const schema = makeSchemaCodec(spec.schema);
  const codec = spec.codec;
  const discardNewer = spec.root === "userCache" || spec.onNewerVersion === "discard";
  const newerError = (operation: string, storedVersion: number, writtenBy: string | undefined) =>
    newerStateVersionError({
      operation,
      path: file,
      storedVersion,
      supportedVersion: spec.version,
      reader: writer,
      ...(writtenBy === undefined ? {} : { writtenBy }),
    });
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

  const readOlderVersion = (
    payload: unknown,
    fromVersion: number,
  ): Effect.Effect<A | null, StateStoreError> => {
    const migrate = spec.onVersionMismatch;
    if (migrate === undefined || migrate === "discard") {
      return Effect.succeed(fallback);
    }
    return Effect.try({
      try: () => migrate(payload, fromVersion),
      catch: (cause) =>
        new StateStoreError({
          reason: "version",
          operation: "get",
          path: file,
          storedVersion: fromVersion,
          supportedVersion: spec.version,
          cause,
          remediation: "The durable state version could not be migrated.",
        }),
    });
  };

  const readValue = (corrupt: typeof handleCorrupt): Effect.Effect<A | null, StateStoreError> =>
    backend.readBytes(file, "get").pipe(
      Effect.flatMap((bytes) => {
        if (bytes === null) return Effect.succeed(fallback);
        try {
          const frame = readFrame(codec, bytes);
          if (frame.version !== null && frame.version > spec.version) {
            return discardNewer
              ? Effect.succeed(fallback)
              : Effect.fail(newerError("get", frame.version, frame.writtenBy));
          }
          const payload = frame.readPayload();
          return frame.version !== null && frame.version !== spec.version
            ? readOlderVersion(payload, frame.version)
            : schema.decode(payload).pipe(Effect.catch(corrupt));
        } catch (cause) {
          return corrupt(cause instanceof Error ? cause : new Error("State codec decode failed.", { cause }));
        }
      }),
    );

  const writeValue = (value: A): Effect.Effect<void, StateStoreError> => {
    if (isCustomCodec(codec)) {
      return Effect.try({
        try: () => codec.encode(value),
        catch: (cause) => decodeError("set", file, cause),
      }).pipe(Effect.flatMap((body) => backend.writeBytes(file, body, "set", writeOptions)));
    }
    return schema.encode(value).pipe(
      mapFailures((cause) => decodeError("set", file, cause)),
      Effect.flatMap((encoded) => {
        const body = encodeFrame(codec, spec.version, encoded, value, writer);
        return backend.writeBytes(file, body, "set", writeOptions);
      }),
    );
  };

  const lock = <B, E>(
    operation: string,
    effect: Effect.Effect<B, E>,
  ): Effect.Effect<B, E | StateStoreError> =>
    lockMode === "advisory" ? backend.withLock(file, operation, effect) : effect;

  const readForMutation = readValue(handleCorrupt);
  const get = (
    onCorrupt === "quarantine" && lockMode === "advisory" && !discardNewer && !isCustomCodec(codec)
      ? readValue(() => lock("get", readForMutation))
      : readForMutation
  ).pipe(Effect.withSpan("StateBucket.get"));

  const protectNewer = (operation: "set" | "remove"): Effect.Effect<void, StateStoreError> =>
    discardNewer || isCustomCodec(codec)
      ? Effect.void
      : backend.readBytes(file, operation).pipe(
          Effect.flatMap((bytes) => {
            if (bytes === null) return Effect.void;
            try {
              const { version, writtenBy } = readFrame(codec, bytes);
              return version !== null && version > spec.version
                ? Effect.fail(newerError(operation, version, writtenBy))
                : Effect.void;
            } catch (cause) {
              if (cause instanceof FrameDecodeError) return Effect.void;
              throw cause;
            }
          }),
        );

  const applyWrite = <B>(write: StateWrite<A, B>): Effect.Effect<B, StateStoreError> => {
    switch (write._tag) {
      case "Keep":
        return Effect.succeed(write.result);
      case "Set":
        return writeValue(write.value).pipe(Effect.as(write.result));
      case "Remove":
        return backend.remove(file).pipe(Effect.as(write.result));
    }
  };

  const lockedWrite = <B, E>(
    operation: string,
    f: (cur: A | null) => Effect.Effect<StateWrite<A, B>, E>,
  ): Effect.Effect<B, E | StateStoreError> =>
    lock(operation, readForMutation.pipe(Effect.flatMap(f), Effect.flatMap(applyWrite)));

  const mutate = Effect.fn("StateBucket.mutate")(
    <B, E>(f: (cur: A | null) => Effect.Effect<StateWrite<A, B>, E>): Effect.Effect<B, E | StateStoreError> =>
      lockedWrite("mutate", f),
  );

  const transition = Effect.fn("StateBucket.transition")(
    <State extends string, Operation extends string, E>(
      t: StateTransition<A, State, Operation, E>,
    ): Effect.Effect<A | null, E | StateStoreError> =>
      lockedWrite("transition", (current): Effect.Effect<StateWrite<A, A | null>, E> => {
        const plan = planTransition(t.transitions, t.operation, t.state(current), (to) =>
          t.next(to, current),
        );
        switch (plan._tag) {
          case "Keep":
            return Effect.succeed({ _tag: "Keep", result: current });
          case "Illegal":
            return Effect.fail(t.illegal(plan.verdict));
          case "Write":
            return Effect.succeed(
              plan.value === null
                ? { _tag: "Remove", result: null }
                : { _tag: "Set", value: plan.value, result: plan.value },
            );
        }
      }),
  );

  const modify = Effect.fn("StateBucket.modify")(
    <B>(f: (cur: A | null) => readonly [B, A]): Effect.Effect<B, StateStoreError> =>
      lockedWrite("modify", (current) => {
        const [result, value] = f(current);
        return Effect.succeed({ _tag: "Set", value, result } as const);
      }),
  );

  const update = Effect.fn("StateBucket.update")(
    (f: (cur: A | null) => A): Effect.Effect<A, StateStoreError> =>
      lockedWrite("update", (current) => {
        const value = f(current);
        return Effect.succeed({ _tag: "Set", value, result: value } as const);
      }),
  );

  const set = Effect.fn("StateBucket.set")(
    (value: A): Effect.Effect<void, StateStoreError> =>
      lock("set", protectNewer("set").pipe(Effect.andThen(writeValue(value)))),
  );

  const remove = lock("remove", protectNewer("remove").pipe(Effect.andThen(backend.remove(file))));
  const exists = backend.exists(file);

  return {
    path,
    get,
    set,
    update,
    modify,
    mutate,
    transition,
    remove: remove.pipe(Effect.withSpan("StateBucket.remove")),
    exists: exists.pipe(Effect.withSpan("StateBucket.exists")),
  } satisfies StateBucket<A>;
};
