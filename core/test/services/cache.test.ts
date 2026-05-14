import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema, TestClock, TestContext } from "effect";

import { CacheError } from "@lando/core/errors";
import { CacheService } from "@lando/core/services";
import { CacheServiceLive } from "../../src/cache/service.ts";

const CachedValue = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
});

const runWithCache = <A>(effect: Effect.Effect<A, CacheError, CacheService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CacheServiceLive)));

describe("CacheServiceLive", () => {
  test("round-trips cached values through schema decode", async () => {
    const value = await runWithCache(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          yield* cache.write("plans:app", { name: "app", count: 1 });
          return yield* cache.read("plans:app", CachedValue);
        }),
      ),
    );

    expect(value).toEqual({ name: "app", count: 1 });
  });

  test("keeps distinct keys isolated", async () => {
    const values = await runWithCache(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          yield* cache.write("apps:first", { name: "first", count: 1 });
          yield* cache.write("apps:second", { name: "second", count: 2 });
          const first = yield* cache.read("apps:first", CachedValue);
          const second = yield* cache.read("apps:second", CachedValue);
          return { first, second };
        }),
      ),
    );

    expect(values).toEqual({
      first: { name: "first", count: 1 },
      second: { name: "second", count: 2 },
    });
  });

  test("returns null for missing and expired keys", async () => {
    const values = await Effect.runPromise(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          const missing = yield* cache.read("missing", CachedValue);
          yield* cache.write("short-lived", { name: "stale", count: 1 }, 1);
          yield* TestClock.adjust("5 millis");
          const expired = yield* cache.read("short-lived", CachedValue);
          return { expired, missing };
        }),
      ).pipe(Effect.provide(CacheServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(values).toEqual({ expired: null, missing: null });
  });

  test("fails loudly when stored data no longer matches the requested schema", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(CacheService, (cache) =>
        Effect.gen(function* () {
          yield* cache.write("bad", { name: "bad", count: "not-a-number" });
          return yield* cache.read("bad", CachedValue);
        }),
      ).pipe(Effect.provide(CacheServiceLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(CacheError);
        expect(failure.value).toMatchObject({
          _tag: "CacheError",
          key: "bad",
        });
        expect(failure.value.decodeError).toBeDefined();
      }
    }
  });
});
