import { Effect } from "effect";
import { Schema } from "effect";

import { PortablePath } from "./primitives.ts";

// ==== Planned mounts ==========================================================
// `ServicePlan.mounts` is the one list of every container path a service gets,
// sorted shallow to deep with unique targets, so the deepest target wins.

/** A host path bound into the container. */
export const BindMountPlan = Schema.Struct({
  type: Schema.Literal("bind").annotate({ description: "Mount kind." }),
  source: Schema.String.annotate({ description: "Host path." }),
  target: PortablePath.annotate({ description: "Mount point inside the container." }),
  readOnly: Schema.Boolean.annotate({ description: "Whether the container sees the mount read-only." }),
  createHostPath: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether the provider may create a missing host source path.",
  }),
  realization: Schema.Literals(["passthrough", "accelerated"]).annotate({
    description: "passthrough binds through the provider; accelerated routes through the file-sync engine.",
  }),
  role: Schema.optionalKey(Schema.Literal("app")).annotate({
    description: "app marks the app-source mount; a service has at most one.",
  }),
  excludes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Paths beneath this mount that belong to the service instead of the host.",
  }),
  includes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Exact entries cancel excludes and the fixed .git sync ignore; nested entries reopen host paths.",
  }),
  mountKey: Schema.optionalKey(Schema.String).annotate({
    description: "File-sync correlation key, present exactly when the mount is accelerated.",
  }),
});
export type BindMountPlan = typeof BindMountPlan.Type;

/** A named data store mounted into the container. */
export const VolumeMountPlan = Schema.Struct({
  type: Schema.Literal("volume").annotate({ description: "Mount kind." }),
  store: Schema.String.annotate({ description: "Name of the mounted data store." }),
  target: PortablePath.annotate({ description: "Mount point inside the container." }),
  readOnly: Schema.Boolean.annotate({ description: "Whether the container sees the mount read-only." }),
  subpath: Schema.optionalKey(Schema.String).annotate({
    description: "Path within the data store to mount instead of its root.",
  }),
});
export type VolumeMountPlan = typeof VolumeMountPlan.Type;

/** A memory-backed filesystem that lives as long as the container. */
export const TmpfsMountPlan = Schema.Struct({
  type: Schema.Literal("tmpfs").annotate({ description: "Mount kind." }),
  target: PortablePath.annotate({ description: "Mount point inside the container." }),
  readOnly: Schema.Boolean.annotate({ description: "Whether the container sees the mount read-only." }),
  options: Schema.optionalKey(Schema.String).annotate({
    description: "Canonical runtime tmpfs options such as size=64m,mode=1777; access mode is readOnly.",
  }),
});
export type TmpfsMountPlan = typeof TmpfsMountPlan.Type;

/** One planned container mount. */
export const MountPlan = Schema.Union([BindMountPlan, VolumeMountPlan, TmpfsMountPlan]);
export type MountPlan = typeof MountPlan.Type;

// ==== Data stores =============================================================
// Named volumes the provider creates and owns; services mount them by name.

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

// ==== Mount list helpers ======================================================
// Derivations every planner, renderer, and verifier shares.

/** Fixed sync-only ignores; these never create volume overlays. */
export const VCS_SYNC_IGNORES = [".git"] as const;

interface MountListOwner {
  readonly mounts: ReadonlyArray<MountPlan>;
}

/** The app-source mount, absent when the service does not mount the app. */
export const serviceAppMount = (service: MountListOwner): BindMountPlan | undefined =>
  service.mounts.find((mount): mount is BindMountPlan => mount.type === "bind" && mount.role === "app");

const targetDepth = (target: string): number =>
  target.split("/").filter((segment) => segment.length > 0).length;

/** Mounts ordered shallow to deep, then by target, so a deeper target always mounts over its parent. */
export const orderMounts = <M extends MountPlan>(mounts: ReadonlyArray<M>): M[] =>
  [...mounts].sort((left, right) => {
    const depth = targetDepth(left.target) - targetDepth(right.target);
    if (depth !== 0) return depth;
    return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
  });

/** The first container target claimed by more than one mount, if any. */
export const duplicateMountTarget = (mounts: ReadonlyArray<MountPlan>): string | undefined => {
  const seen = new Set<string>();
  for (const mount of mounts) {
    if (seen.has(mount.target)) return mount.target;
    seen.add(mount.target);
  }
  return undefined;
};

/** Excludes left after exact `includes` entries cancel them. */
export const effectiveExcludes = (bind: Pick<BindMountPlan, "excludes" | "includes">): readonly string[] => {
  const includes = new Set(bind.includes ?? []);
  return (bind.excludes ?? []).filter((entry) => !entry.startsWith("!") && !includes.has(entry));
};

const targetPrefix = (target: string): string => `${target.replace(/\/+$/u, "")}/`;

/**
 * Ordered sync ignores for an accelerated bind: its effective excludes, the
 * relative target of every other mount beneath it, then `.git` unless included.
 */
export const bindSyncIgnores = (service: MountListOwner, bind: BindMountPlan): readonly string[] => {
  const includes = new Set(bind.includes ?? []);
  const ignores = new Set(effectiveExcludes(bind));
  const prefix = targetPrefix(bind.target);
  for (const mount of service.mounts) {
    if (mount !== bind && mount.target.startsWith(prefix)) ignores.add(mount.target.slice(prefix.length));
  }
  for (const entry of VCS_SYNC_IGNORES) {
    if (!includes.has(entry)) ignores.add(entry);
  }
  return [...ignores];
};

/** Shared file-sync volume naming used by the planner and providers. */
export const fileSyncVolumeName = (appName: string, serviceName: string, mountKey: string): string =>
  `${appName}-${serviceName}-${mountKey}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

/** One accelerated bind's expected file-sync session, derived from the plan alone. */
export interface PlannedFileSyncSession {
  readonly service: string;
  readonly mountKey: string;
  readonly source: string;
  readonly targetPath: PortablePath;
  readonly volumeName: string;
  readonly excludes: readonly string[];
}

/**
 * The single derivation of the sessions an app's accelerated binds need. The
 * planner builds `AppPlan.fileSync` from it and verifiers compare against it.
 * A bind marked accelerated without a `mountKey` yields `undefined`.
 */
export const plannedFileSyncSessions = (plan: {
  readonly name: string;
  readonly services: Readonly<Record<string, MountListOwner>>;
}): readonly PlannedFileSyncSession[] | undefined => {
  const sessions: PlannedFileSyncSession[] = [];
  for (const [serviceName, service] of Object.entries(plan.services)) {
    for (const mount of service.mounts) {
      if (mount.type !== "bind" || mount.realization !== "accelerated") continue;
      if (mount.mountKey === undefined) return undefined;
      sessions.push({
        service: serviceName,
        mountKey: mount.mountKey,
        source: mount.source,
        targetPath: mount.target,
        volumeName: fileSyncVolumeName(plan.name, serviceName, mount.mountKey),
        excludes: bindSyncIgnores(service, mount),
      });
    }
  }
  return sessions;
};
