import { Effect } from "effect";
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
  /** Overlay excludes: per-service empty directories, also ignored during sync. */
  excludes: Schema.Array(Schema.String),
  /** Includes — exact entries here cancel excludes and fixed VCS ignores. */
  includes: Schema.Array(Schema.String),
  /**
   * `passthrough` — provider-native bind mount.
   * `accelerated` — routed through the active FileSyncEngine.
   */
  realization: Schema.Literals(["passthrough", "accelerated"]),
});
export type AppMountPlan = typeof AppMountPlan.Type;

/**
 * Generic mount plan — any non-app, non-storage mount.
 */
export const MountPlan = Schema.Struct({
  /** Mount type: `bind` (host path), `tmpfs`, or `volume` (named/anon). */
  type: Schema.Literals(["bind", "tmpfs", "volume"]),
  /** Host path (`bind`), volume name (`volume`), or undefined (`tmpfs`). */
  source: Schema.optionalKey(Schema.String),
  /** Mount point inside the container. */
  target: PortablePath,
  /** Read-only? */
  readOnly: Schema.Boolean,
  /** For bind mounts, whether the provider may create a missing host source path. */
  createHostPath: Schema.optionalKey(Schema.Boolean),
  /** Realization strategy (same semantics as AppMountPlan.realization). */
  realization: Schema.Literals(["passthrough", "accelerated"]),
});
export type MountPlan = typeof MountPlan.Type;

/**
 * Storage scope — drives auto-naming for named volumes.
 */
export const StorageScope = Schema.Literals(["service", "app", "global"]);
export type StorageScope = typeof StorageScope.Type;

/**
 * Data store — a named, persistent volume the provider must create.
 */
export const DataStorePlan = Schema.Struct({
  /** Provider-visible volume name (already auto-scoped). */
  name: Schema.String,
  scope: StorageScope,
  /** Storage kind; `cache` stores are cross-app shared dependency caches. */
  kind: Schema.Literals(["data", "cache"]).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => "data" as const)),
  ),
  /** Cache identity when `kind` is `cache`. */
  key: Schema.optionalKey(Schema.String),
  /** Driver (provider-specific; `null` = default). */
  driver: Schema.optionalKey(Schema.String),
  /** Optional driver opts. */
  driverOpts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
  /** Optional path within the data store to mount instead of its root. */
  subpath: Schema.optionalKey(Schema.String),
});
export type DataStoreMountPlan = typeof DataStoreMountPlan.Type;

/** Fixed sync-only ignores; these never create volume overlays. */
export const VCS_SYNC_IGNORES = [".git"] as const;

/** Ordered sync ignores derived from the finalized service's app mount and non-bind overlays. */
export const appMountSyncIgnores = (service: {
  readonly appMount?: AppMountPlan | undefined;
  readonly storage: readonly (string | DataStoreMountPlan)[];
  readonly mounts: readonly MountPlan[];
}): readonly string[] => {
  const { appMount } = service;
  if (appMount === undefined) return [];
  const includes = new Set(appMount.includes);
  const ignores = new Set(appMount.excludes.filter((entry) => !includes.has(entry)));
  const prefix = `${appMount.target.replace(/\/+$/u, "")}/`;
  const targets = [
    ...service.storage.map((entry) => (typeof entry === "string" ? entry : entry.target)),
    ...service.mounts.filter((mount) => mount.type !== "bind").map((mount) => mount.target),
  ];
  for (const target of targets) {
    if (target.startsWith(prefix)) ignores.add(target.slice(prefix.length));
  }
  for (const entry of VCS_SYNC_IGNORES) {
    if (!includes.has(entry)) ignores.add(entry);
  }
  return [...ignores];
};
