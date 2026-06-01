import { Schema } from "effect";

import { AbsolutePath, PortablePath } from "./primitives.ts";

/**
 * App mount — the special mount of the app source root into the service.
 */
export const AppMountPlan = Schema.Struct({
  /** Absolute host path of the app root. */
  source: AbsolutePath,
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
  /** Excludes (gitignore-flavoured patterns). */
  excludes: Schema.Array(Schema.String),
  /** Includes — entries matched here override `excludes`. */
  includes: Schema.Array(Schema.String),
  /**
   * `passthrough` — provider-native bind mount.
   * `accelerated` — routed through the active FileSyncEngine.
   */
  realization: Schema.Literal("passthrough", "accelerated"),
});
export type AppMountPlan = typeof AppMountPlan.Type;

/**
 * Generic mount plan — any non-app, non-storage mount.
 */
export const MountPlan = Schema.Struct({
  /** Mount type: `bind` (host path), `tmpfs`, or `volume` (named/anon). */
  type: Schema.Literal("bind", "tmpfs", "volume"),
  /** Host path (`bind`), volume name (`volume`), or undefined (`tmpfs`). */
  source: Schema.optional(Schema.String),
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
  /** Realization strategy (same semantics as AppMountPlan.realization). */
  realization: Schema.Literal("passthrough", "accelerated"),
});
export type MountPlan = typeof MountPlan.Type;

/**
 * Storage scope — drives auto-naming for named volumes.
 */
export const StorageScope = Schema.Literal("service", "app", "global");
export type StorageScope = typeof StorageScope.Type;

/**
 * Data store — a named, persistent volume the provider must create.
 */
export const DataStorePlan = Schema.Struct({
  /** Provider-visible volume name (already auto-scoped). */
  name: Schema.String,
  scope: StorageScope,
  /** Driver (provider-specific; `null` = default). */
  driver: Schema.optional(Schema.String),
  /** Optional driver opts. */
  driverOpts: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type DataStorePlan = typeof DataStorePlan.Type;

/**
 * Mount of a `DataStorePlan` into a service.
 */
export const DataStoreMountPlan = Schema.Struct({
  /** Name of the DataStorePlan being mounted. */
  store: Schema.String,
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
});
export type DataStoreMountPlan = typeof DataStoreMountPlan.Type;
