// In-memory `StateStore` test double. Mirrors `StateStoreLive` semantics (codec
// framing, version mismatch, corruption policy, path containment, advisory
// serialization) against a `Map` of absolute paths to bytes so
// `runStateStoreContract` can run without disk IO.

import { dirname, resolve } from "node:path";

import { Effect, Layer } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import {
  type StateBucket,
  type StateBucketSpec,
  type StateMigrator,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";

import {
  type DecodedFrame,
  decodeFrame,
  encodeFrame,
  isCustomCodec,
  makeSchemaCodec,
} from "../state/codec.ts";
import { resolveStatePath } from "../state/paths.ts";

const textEncoder = new TextEncoder();

const toBytes = (bytes: Uint8Array | string): Uint8Array =>
  typeof bytes === "string" ? textEncoder.encode(bytes) : new Uint8Array(bytes);

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

const inProcessGuards = new Map<string, Effect.Semaphore>();

const guardFor = (file: string): Effect.Semaphore => {
  const existing = inProcessGuards.get(file);
  if (existing !== undefined) return existing;
  const created = Effect.unsafeMakeSemaphore(1);
  inProcessGuards.set(file, created);
  return created;
};

const withInMemoryAdvisoryLock = <A, E>(file: string, body: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  guardFor(file).withPermits(1)(body);

const buildInMemoryBucket = <A, I>(
  spec: StateBucketSpec<A, I>,
  file: string,
  files: Map<string, Uint8Array>,
): StateBucket<A> => {
  const path = file as AbsolutePath;
  const onCorrupt = spec.onCorrupt ?? "quarantine";
  const lockMode = spec.lock ?? "none";
  const fallback: A | null = spec.default ?? null;
  const schema = makeSchemaCodec(spec.schema);
  const codec = spec.codec;

  const readBytes = Effect.sync((): Uint8Array | null => {
    const bytes = files.get(file);
    return bytes === undefined ? null : new Uint8Array(bytes);
  });

  const quarantine = Effect.sync(() => {
    const bytes = files.get(file);
    if (bytes === undefined) return;
    files.delete(file);
    files.set(`${file}.corrupt-${Date.now()}`, new Uint8Array(bytes));
  });

  const handleCorrupt = (cause: unknown): Effect.Effect<A | null, StateStoreError> => {
    if (onCorrupt === "fail") return Effect.fail(decodeError("get", file, cause));
    const recover = Effect.succeed<A | null>(fallback);
    return onCorrupt === "quarantine" ? quarantine.pipe(Effect.zipRight(recover)) : recover;
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
      Effect.catchAll((cause) => handleCorrupt(cause)),
    );

  const get: Effect.Effect<A | null, StateStoreError> = readBytes.pipe(
    Effect.flatMap((bytes) => {
      if (bytes === null) return Effect.succeed(fallback);
      let frame: DecodedFrame;
      try {
        frame = decodeFrame(codec, bytes);
      } catch (cause) {
        return handleCorrupt(cause);
      }
      if (frame.version !== null && frame.version !== spec.version) {
        return applyVersionMismatch(frame.payload, frame.version);
      }
      return decodeValue(frame.payload);
    }),
  );

  const writeValue = (value: A): Effect.Effect<void, StateStoreError> => {
    if (isCustomCodec(codec)) {
      return Effect.try({
        try: () => codec.encode(value),
        catch: (cause) => decodeError("set", file, cause),
      }).pipe(
        Effect.flatMap((body) =>
          Effect.sync(() => {
            files.set(file, toBytes(body));
          }),
        ),
      );
    }
    return schema.encode(value).pipe(
      Effect.mapError((cause) => decodeError("set", file, cause)),
      Effect.flatMap((encoded) => {
        const body = encodeFrame(codec, spec.version, encoded, value);
        return Effect.sync(() => {
          files.set(file, toBytes(body));
        });
      }),
    );
  };

  const lock = <B, E>(effect: Effect.Effect<B, E>): Effect.Effect<B, E> =>
    lockMode === "advisory" ? withInMemoryAdvisoryLock(file, effect) : effect;

  const modify = <B>(f: (cur: A | null) => readonly [B, A]): Effect.Effect<B, StateStoreError> =>
    lock(
      get.pipe(
        Effect.flatMap((current) => {
          const [result, next] = f(current);
          return writeValue(next).pipe(Effect.as(result));
        }),
      ),
    );

  const update = (f: (cur: A | null) => A): Effect.Effect<A, StateStoreError> =>
    lock(
      get.pipe(
        Effect.flatMap((current) => {
          const next = f(current);
          return writeValue(next).pipe(Effect.as(next));
        }),
      ),
    );

  const set = (value: A): Effect.Effect<void, StateStoreError> => lock(writeValue(value));

  const remove: Effect.Effect<void, StateStoreError> = lock(Effect.sync(() => void files.delete(file)));

  const exists: Effect.Effect<boolean, StateStoreError> = Effect.sync(() => files.has(file));

  return { path, get, set, update, modify, remove, exists } satisfies StateBucket<A>;
};

const makeInMemoryStateStore = (files: Map<string, Uint8Array>): StateStoreShape => ({
  open: <A, I>(spec: StateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
    resolveStatePath(spec.root, spec.namespace, spec.key, "open").pipe(
      Effect.map((resolved) => buildInMemoryBucket(spec, resolved.file, files)),
    ),
});

export interface TestStateStore {
  readonly service: StateStoreShape;
  readonly layer: Layer.Layer<StateStore>;
  readonly readRaw: (file: AbsolutePath) => Effect.Effect<Uint8Array | null>;
  readonly list: (dir: AbsolutePath) => Effect.Effect<ReadonlyArray<string>>;
  readonly writeRaw: (file: AbsolutePath, bytes: Uint8Array | string) => Effect.Effect<void>;
  readonly snapshot: () => ReadonlyMap<string, Uint8Array>;
}

export const makeTestStateStore = (): TestStateStore => {
  const files = new Map<string, Uint8Array>();
  const service = makeInMemoryStateStore(files);

  const readRaw = (file: AbsolutePath): Effect.Effect<Uint8Array | null> =>
    Effect.sync(() => {
      const bytes = files.get(file);
      return bytes === undefined ? null : new Uint8Array(bytes);
    });

  const writeRaw = (file: AbsolutePath, bytes: Uint8Array | string): Effect.Effect<void> =>
    Effect.sync(() => {
      files.set(file, toBytes(bytes));
    });

  const list = (dir: AbsolutePath): Effect.Effect<ReadonlyArray<string>> =>
    Effect.sync(() => {
      const dirResolved = resolve(dir);
      const names: string[] = [];
      for (const key of files.keys()) {
        if (resolve(dirname(key)) === dirResolved) {
          const base = key.slice(key.lastIndexOf("/") + 1);
          if (base.length > 0) names.push(base);
        }
      }
      return names;
    });

  const snapshot = (): ReadonlyMap<string, Uint8Array> =>
    new Map(Array.from(files.entries(), ([k, v]) => [k, new Uint8Array(v)]));

  return {
    service,
    layer: Layer.succeed(StateStore, service),
    readRaw,
    list,
    writeRaw,
    snapshot,
  };
};
