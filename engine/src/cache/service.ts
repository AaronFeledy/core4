import { Clock, type Context, Effect, Layer, Ref, Schema } from "effect";

import { CacheError } from "@lando/sdk/errors";
import { CacheService } from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";

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

const decodeStored = <A, I>(key: string, value: unknown, schema?: Schema.Codec<A, I>) => {
  if (schema === undefined) {
    return Effect.succeed(value as A);
  }

  return Schema.decodeUnknownEffect(schema)(value).pipe(
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
): Context.Service.Shape<typeof CacheService> => ({
  read: Effect.fn("CacheService.read")(function* <A, I>(key: string, schema?: Schema.Codec<A, I>) {
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
  write: Effect.fn("CacheService.write")(function* (key, value, ttlMs) {
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

export const layerWithPrivateFileAccess: Layer.Layer<CacheService, never, PrivateFileAccessService> =
  Layer.unwrap(
    Effect.map(PrivateFileAccessService, (privateFileAccess) => makeCacheServiceLayer(privateFileAccess)),
  );

export const layer = layerWithPrivateFileAccess.pipe(Layer.provide(PrivateFileAccessService.layer));

export { CacheService };
