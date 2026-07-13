import { Context, type Effect, type Schema } from "effect";

import type { StateStoreError } from "../errors/index.ts";
import type { AbsolutePath } from "../schema/index.ts";

/**
 * Where a bucket file is rooted. The three named roots resolve through the
 * Paths/Roots primitive; `{ app }` scopes the bucket under an app root and
 * `{ path }` pins an explicit absolute directory for host/test isolation.
 */
export type StateRoot =
  | "userData"
  | "userCache"
  | "userConf"
  | { readonly app: AbsolutePath }
  | { readonly path: AbsolutePath };

/**
 * How a bucket's payload is encoded on disk. `json` wraps `{ version, data }`,
 * `binary` writes the magic-header binary envelope, and a custom codec carries
 * a user-facing on-disk format (e.g. the include lockfile's block-style YAML).
 */
export type StateCodec<A, _I> =
  | "json"
  | "binary"
  | {
      readonly encode: (a: A) => string | Uint8Array;
      readonly decode: (raw: Uint8Array) => A;
    };

/**
 * Upgrades durable data whose on-disk `version` is older than the bucket's
 * declared `version`, given the raw decoded payload and the version it was
 * written at.
 */
export type StateMigrator<A> = (raw: unknown, fromVersion: number) => A;

/**
 * Declares a single durable document: its root, namespace, filename, schema,
 * version, and the corruption / version-mismatch / locking policies the store
 * enforces. `open` resolves and containment-checks the path without IO.
 */
export interface StateBucketSpec<A, I> {
  readonly root: StateRoot;
  readonly namespace?: string;
  readonly key: string;
  readonly schema: Schema.Schema<A, I>;
  readonly version: number;
  readonly codec?: StateCodec<A, I>;
  /** Exact permissions applied to each atomic replacement, after umask. */
  readonly mode?: number;
  readonly lock?: "none" | "advisory";
  readonly onCorrupt?: "discard" | "quarantine" | "fail";
  readonly onVersionMismatch?: "discard" | StateMigrator<A>;
  readonly default?: A;
}

/**
 * A handle to exactly one durable file. `get` reads (returning `null`/`default`
 * when absent), `set` atomically replaces, `update`/`modify` read-modify-write
 * (serialized cross-process when the bucket is `advisory`-locked), and `remove`
 * / `exists` manage presence.
 */
export interface StateBucket<A> {
  readonly path: AbsolutePath;
  readonly get: Effect.Effect<A | null, StateStoreError>;
  readonly set: (value: A) => Effect.Effect<void, StateStoreError>;
  readonly update: (f: (cur: A | null) => A) => Effect.Effect<A, StateStoreError>;
  readonly modify: <B>(f: (cur: A | null) => readonly [B, A]) => Effect.Effect<B, StateStoreError>;
  readonly remove: Effect.Effect<void, StateStoreError>;
  readonly exists: Effect.Effect<boolean, StateStoreError>;
}

/** The `StateStore` service surface: mint `StateBucket` handles from a spec. */
export interface StateStoreShape {
  readonly open: <A, I>(spec: StateBucketSpec<A, I>) => Effect.Effect<StateBucket<A>, StateStoreError>;
}

/**
 * The single core service for durable, atomic, schema-validated, versioned,
 * optionally cross-process-locked on-disk documents. Available eagerly at
 * bootstrap level `minimal`, host/test-overridable, but NOT a plugin
 * contribution surface (there is no `provides.stateStores` manifest key).
 */
export class StateStore extends Context.Tag("@lando/core/StateStore")<StateStore, StateStoreShape>() {}
