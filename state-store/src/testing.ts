import { basename, dirname, resolve } from "node:path";
import type { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import {
  type StateBucket,
  type StateBucketSpec,
  type StateLockOptions,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";
import { Clock, Deferred, Effect, Layer, Option } from "effect";

import { type StateBucketBackend, buildStateBucket } from "./bucket.ts";
import { lockTimeout, lockWaitBudget } from "./lock.ts";
import { makeLockGate } from "./lock-gate.ts";
import { makeLockReentryGuard } from "./lock-reentry.ts";
import { resolveStatePath } from "./paths.ts";
import { validateBucketSpec } from "./spec.ts";

const textEncoder = new TextEncoder();

const toBytes = (bytes: Uint8Array | string): Uint8Array =>
  typeof bytes === "string" ? textEncoder.encode(bytes) : new Uint8Array(bytes);

// The same FIFO, writer-preferring gate production uses in-process, one per store.
const makeMemoryLocks = () => {
  const enter = makeLockReentryGuard();
  const gate = makeLockGate();
  return <A, E, R>(file: string, body: Effect.Effect<A, E, R>, options: StateLockOptions = {}) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* enter(file);
        const timeoutMs = lockWaitBudget(options);
        const pending = yield* gate(file, options.mode ?? "exclusive");
        if (pending !== undefined) {
          const granted = yield* Deferred.await(pending).pipe(Effect.timeoutOption(timeoutMs));
          if (Option.isNone(granted))
            return yield* Effect.fail(
              lockTimeout(
                {
                  path: file,
                  operation: "withLock",
                  resource: options.resource ?? file,
                  timeoutMs,
                  wait: options.wait ?? "brief",
                  subject: "resource",
                },
                null,
                yield* Clock.currentTimeMillis,
              ),
            );
        }
        return yield* body;
      }),
    );
};

const makeMemoryBucketBackend = (
  files: Map<string, Uint8Array>,
  withInMemoryAdvisoryLock: ReturnType<typeof makeMemoryLocks>,
): StateBucketBackend => ({
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

const makeInMemoryStateStore = (files: Map<string, Uint8Array>): StateStoreShape => {
  const withInMemoryAdvisoryLock = makeMemoryLocks();
  return StateStore.of({
    open: Effect.fn("StateStore.open")(
      <A, I>(spec: StateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
        resolveStatePath(spec.root, spec.namespace, spec.key, "open").pipe(
          Effect.tap(() => validateBucketSpec(spec)),
          Effect.map((resolved) =>
            buildStateBucket(spec, resolved.file, makeMemoryBucketBackend(files, withInMemoryAdvisoryLock)),
          ),
        ),
    ),
    withLock: Effect.fn("StateStore.withLock")(
      <A, E, R>(key: string, body: Effect.Effect<A, E, R>, options?: StateLockOptions) =>
        withInMemoryAdvisoryLock(`operation-locks/${key}`, body, { resource: key, ...options }),
    ),
  });
};

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
