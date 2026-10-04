import { basename, dirname, resolve } from "node:path";

import { Effect, Layer, Semaphore } from "effect";

import type { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import {
  type StateBucket,
  type StateBucketSpec,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";

import { type StateBucketBackend, buildStateBucket } from "./bucket.ts";
import { resolveStatePath } from "./paths.ts";

const textEncoder = new TextEncoder();

const toBytes = (bytes: Uint8Array | string): Uint8Array =>
  typeof bytes === "string" ? textEncoder.encode(bytes) : new Uint8Array(bytes);

const inProcessGuards = new Map<string, Semaphore.Semaphore>();

const guardFor = (file: string): Semaphore.Semaphore => {
  const existing = inProcessGuards.get(file);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  inProcessGuards.set(file, created);
  return created;
};

const withInMemoryAdvisoryLock = <A, E>(file: string, body: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  guardFor(file).withPermits(1)(body);

const makeMemoryBucketBackend = (files: Map<string, Uint8Array>): StateBucketBackend => ({
  readBytes: (file) =>
    Effect.sync(() => {
      const bytes = files.get(file);
      return bytes === undefined ? null : new Uint8Array(bytes);
    }),
  writeBytes: (file, body) =>
    Effect.sync(() => {
      files.set(file, toBytes(body));
    }),
  remove: (file) => Effect.sync(() => void files.delete(file)),
  exists: (file) => Effect.sync(() => files.has(file)),
  quarantine: (file, now) =>
    Effect.sync(() => {
      const bytes = files.get(file);
      if (bytes === undefined) return;
      files.delete(file);
      files.set(`${file}.corrupt-${now}`, new Uint8Array(bytes));
    }),
  withLock: (file, _operation, body) => withInMemoryAdvisoryLock(file, body),
});

const makeInMemoryStateStore = (files: Map<string, Uint8Array>): StateStoreShape =>
  StateStore.of({
    open: Effect.fn("StateStore.open")(
      <A, I>(spec: StateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
        resolveStatePath(spec.root, spec.namespace, spec.key, "open").pipe(
          Effect.map((resolved) => buildStateBucket(spec, resolved.file, makeMemoryBucketBackend(files))),
        ),
    ),
    withLock: Effect.fn("StateStore.withLock")(<A, E>(key: string, body: Effect.Effect<A, E>) =>
      withInMemoryAdvisoryLock(`operation-locks/${key}`, body),
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
          const base = basename(key);
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
