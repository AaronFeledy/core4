import { Context, type Effect, type Schema } from "effect";

import type { CacheError } from "../errors/index.ts";

export class CacheService extends Context.Tag("@lando/core/CacheService")<
  CacheService,
  {
    readonly read: <A, I>(key: string, schema?: Schema.Schema<A, I>) => Effect.Effect<A | null, CacheError>;
    readonly write: <A>(key: string, value: A, ttlMs?: number) => Effect.Effect<void, CacheError>;
    readonly writeAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, CacheError>;
    readonly invalidate: (key: string) => Effect.Effect<void, CacheError>;
  }
>() {}
