import { Clock, type Context, Effect, Layer, Ref, Schema } from "effect";

import { CacheError } from "@lando/sdk/errors";
import { CacheService } from "@lando/sdk/services";
import {
  type PrivateFileAccess,
  PrivateFileAccessLive,
  PrivateFileAccessService,
} from "@lando/state-store/private-file-access";

import { writeAtomicCacheFile } from "./atomic.ts";

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAtMs?: number;
}

const expired = (entry: CacheEntry, nowMs: number): boolean =>
  entry.expiresAtMs !== undefined && entry.expiresAtMs <= nowMs;

const removeKey = (entries: ReadonlyMap<string, CacheEntry>, key: string): Map<string, CacheEntry> => {
  const next = new Map(entries);
  next.delete(key);
  return next;
};

const decodeStored = <A, I>(key: string, value: unknown, schema?: Schema.Schema<A, I>) => {
  if (schema === undefined) {
    return Effect.succeed(value as A);
  }

  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      (decodeError) =>
        new CacheError({
          message: `Cached value for ${key} failed schema decode.`,
          key,
          decodeError,
        }),
    ),
  );
};

const makeCacheService = (
  entries: Ref.Ref<ReadonlyMap<string, CacheEntry>>,
  privateFileAccess: PrivateFileAccess,
): Context.Tag.Service<typeof CacheService> => ({
  read: <A, I>(key: string, schema?: Schema.Schema<A, I>) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const entry = (yield* Ref.get(entries)).get(key);

      if (entry === undefined) {
        return null;
      }

      if (expired(entry, nowMs)) {
        yield* Ref.update(entries, (current) => removeKey(current, key));
        return null;
      }

      return yield* decodeStored(key, entry.value, schema);
    }),
  write: (key, value, ttlMs) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(entries, (current) =>
        new Map(current).set(key, {
          value,
          ...(ttlMs === undefined ? {} : { expiresAtMs: nowMs + ttlMs }),
        }),
      );
    }),
  writeAtomic: (path, content) => writeAtomicCacheFile(path, content, privateFileAccess.enforce),
  invalidate: (key) => Ref.update(entries, (current) => removeKey(current, key)),
});

const makeCacheServiceLayer = (privateFileAccess: PrivateFileAccess) =>
  Layer.effect(
    CacheService,
    Ref.make<ReadonlyMap<string, CacheEntry>>(new Map()).pipe(
      Effect.map((entries) => makeCacheService(entries, privateFileAccess)),
    ),
  );

export const CacheServiceWithPrivateFileAccessLive: Layer.Layer<
  CacheService,
  never,
  PrivateFileAccessService
> = Layer.unwrapEffect(
  Effect.map(PrivateFileAccessService, (privateFileAccess) => makeCacheServiceLayer(privateFileAccess)),
);

export const CacheServiceLive = CacheServiceWithPrivateFileAccessLive.pipe(
  Layer.provide(PrivateFileAccessLive),
);

export { CacheService };
