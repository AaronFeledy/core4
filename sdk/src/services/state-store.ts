import { Context, type Effect, type Schema } from "effect";

import { sha256Hex } from "../digest/index.ts";
import type { StateStoreError } from "../errors/index.ts";
import type { AbsolutePath } from "../schema/index.ts";
import type { IllegalTransition, Transitions } from "../transitions/index.ts";

/**
 * Where a bucket file is rooted. The three named roots resolve through the
 * Paths/Roots primitive; `{ app }` scopes the bucket under an app root and
 * `{ path }` pins an explicit absolute directory for host/test isolation.
 */
export type DurableStateRoot =
  | "userData"
  | "userConf"
  | { readonly app: AbsolutePath }
  | { readonly path: AbsolutePath };

export type StateRoot = DurableStateRoot | "userCache";

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
interface StateBucketFields<A, I> {
  readonly namespace?: string;
  readonly key: string;
  readonly schema: Schema.Codec<A, I>;
  readonly version: number;
  readonly codec?: StateCodec<A, I>;
  /** Exact permissions applied to each atomic replacement, after umask. */
  readonly mode?: number;
  readonly lock?: "none" | "advisory";
}

export interface DurableStateBucketSpec<A, I> extends StateBucketFields<A, I> {
  readonly root: DurableStateRoot;
  readonly onCorrupt?: "discard" | "quarantine" | "fail";
  readonly onVersionMismatch?: "discard" | StateMigrator<A>;
  readonly default?: NoInfer<A>;
}

/**
 * Contents must be regenerable. The user cache root can disappear between any
 * two operations, so a cache read must tolerate absence and corruption.
 */
export interface CacheStateBucketSpec<A, I> extends StateBucketFields<A, I> {
  readonly root: "userCache";
  readonly default: NoInfer<A>;
  readonly onCorrupt?: "discard" | "quarantine";
  readonly onVersionMismatch?: "discard";
}

export type StateBucketSpec<A, I> = DurableStateBucketSpec<A, I> | CacheStateBucketSpec<A, I>;

/** What one locked read-modify-write does with the record it read. */
export type StateWrite<A, B> =
  | { readonly _tag: "Keep"; readonly result: B }
  | { readonly _tag: "Set"; readonly value: A; readonly result: B }
  | { readonly _tag: "Remove"; readonly result: B };

/** One declared operation applied to the record a bucket holds. */
export interface StateTransition<A, State extends string, Operation extends string, E> {
  readonly transitions: Transitions<State, Operation>;
  readonly operation: Operation;
  /** The state the stored record, or its absence, is in. */
  readonly state: (current: A | null) => State;
  /** The record an advance stores; `null` removes the file. */
  readonly next: (to: State, current: A | null) => A | null;
  readonly illegal: (verdict: IllegalTransition<State>) => E;
}

/**
 * A handle to exactly one durable file. `get` reads (returning `null`/`default`
 * when absent), `set` atomically replaces, and `remove` / `exists` manage presence.
 * `update`, `modify`, `mutate`, and `transition` read and write under the bucket's
 * lock (cross-process when the bucket is `advisory`-locked); `mutate` and
 * `transition` skip the write when nothing changes and can remove the file.
 */
export interface StateBucket<A> {
  readonly path: AbsolutePath;
  readonly get: Effect.Effect<A | null, StateStoreError>;
  readonly set: (value: A) => Effect.Effect<void, StateStoreError>;
  readonly update: (f: (cur: A | null) => A) => Effect.Effect<A, StateStoreError>;
  readonly modify: <B>(f: (cur: A | null) => readonly [B, A]) => Effect.Effect<B, StateStoreError>;
  readonly mutate: <B, E = never>(
    f: (cur: A | null) => Effect.Effect<StateWrite<A, B>, E>,
  ) => Effect.Effect<B, E | StateStoreError>;
  /** Returns the stored record after the operation; a settled operation writes nothing. */
  readonly transition: <State extends string, Operation extends string, E>(
    transition: StateTransition<A, State, Operation, E>,
  ) => Effect.Effect<A | null, E | StateStoreError>;
  readonly remove: Effect.Effect<void, StateStoreError>;
  readonly exists: Effect.Effect<boolean, StateStoreError>;
}

/** The `StateStore` service surface: mint `StateBucket` handles from a spec. */
export class StateStore extends Context.Service<
  StateStore,
  {
    readonly open: <A, I>(spec: StateBucketSpec<A, I>) => Effect.Effect<StateBucket<A>, StateStoreError>;
    /** Serialize an arbitrary scoped operation by a durable, host-wide lock key. */
    readonly withLock: <A, E, R>(
      key: string,
      body: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StateStoreError, R>;
  }
>()("@lando/core/StateStore") {}

/** Stable advisory-lock key shared by every writer of one physical volume. */
export const physicalVolumeLockKey = (instanceId: string): string => sha256Hex(instanceId);

/**
 * The single core service for durable, atomic, schema-validated, versioned,
 * optionally cross-process-locked on-disk documents. Available eagerly at
 * bootstrap level `minimal`, host/test-overridable, but NOT a plugin
 * contribution surface (there is no `provides.stateStores` manifest key).
 */
export type StateStoreShape = StateStore["Service"];
