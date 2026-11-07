import { Effect, Schema } from "effect";

import type { AppPlan, FileSyncPlan } from "./app-plan.ts";
import type { FileSyncSessionSpec } from "./file-sync-engine.ts";
import { PortablePath } from "./primitives.ts";

// ==== Planned mounts ==========================================================
// `ServicePlan.mounts` is the one list of every container path a service gets,
// sorted shallow to deep with unique targets, so the deepest target wins.

/**
 * Who asked for a mount: the Landofile, the service type or a feature, core's
 * own derivations (exclude shadows, nested includes, Git, home), or a
 * start-time integration overlay. Absent on plans recorded before provenance.
 */
export const MountOrigin = Schema.Literals(["authored", "service", "derived", "integration"]).annotate({
  identifier: "MountOrigin",
  description: "Who declared a planned mount: the Landofile, the service type, core, or an integration.",
});
export type MountOrigin = typeof MountOrigin.Type;

const originField = Schema.optionalKey(MountOrigin).annotate({
  description: "Who declared this mount; absent on plans recorded before provenance existed.",
});

/** A host path bound into the container. */
export const BindMountPlan = Schema.Struct({
  type: Schema.Literal("bind").annotate({ description: "Mount kind." }),
  source: Schema.String.annotate({ description: "Host path." }),
  sourceIdentity: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional host source identity included in container create fingerprints; replacing the source requires a remount even when its path is unchanged.",
  }),
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
  origin: originField,
  relativeTo: Schema.optionalKey(Schema.Literal("app")).annotate({
    description: "app when the source was resolved from the app root, so isolation can rebase or drop it.",
  }),
  fileMode: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0o7777 }))).annotate({
    description:
      "Permission bits for a private copy of a file source that the provider binds instead of the file.",
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
  origin: originField,
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
  origin: originField,
});
export type TmpfsMountPlan = typeof TmpfsMountPlan.Type;

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
    if (left.target < right.target) return -1;
    if (left.target > right.target) return 1;
    return 0;
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

/**
 * Ordered sync ignores for an accelerated bind: its effective excludes, the
 * relative target of every other mount beneath it, then `.git` unless included.
 */
export const bindSyncIgnores = (service: MountListOwner, bind: BindMountPlan): readonly string[] => {
  const includes = new Set(bind.includes ?? []);
  const ignores = new Set(effectiveExcludes(bind));
  const prefix = `${bind.target.replace(/\/+$/u, "")}/`;
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

// ==== File-sync session coverage ==============================================
// Structural verification shared by the engine and providers.

export type FileSyncCoverageEntry = Pick<FileSyncPlan, "session">;

/** Plan shape required to verify accelerated session coverage. */
export type FileSyncCoveragePlan = Pick<AppPlan, "id" | "name" | "root"> & {
  readonly services: Readonly<Record<string, MountListOwner>>;
  readonly fileSync: ReadonlyArray<FileSyncCoverageEntry>;
};

/**
 * True when every accelerated bind has exactly one matching session and no
 * extras or duplicates, with exact derived ignores from
 * {@link plannedFileSyncSessions}. Providers may pass realpath-aware
 * `pathEquals`; the default is string equality.
 */
export const hasStructuralFileSyncCoverage = (
  plan: FileSyncCoveragePlan,
  options?: {
    readonly sessions?: ReadonlyArray<FileSyncSessionSpec>;
    readonly pathEquals?: (left: string, right: string) => boolean;
  },
): boolean => {
  const expected = plannedFileSyncSessions(plan);
  const sessions = options?.sessions ?? plan.fileSync.map((entry) => entry.session);
  const pathEquals = options?.pathEquals ?? ((left: string, right: string) => left === right);
  if (
    expected === undefined ||
    expected.length === 0 ||
    sessions.length !== expected.length ||
    plan.fileSync.length !== expected.length
  )
    return false;

  const plannedKeys = new Set<string>();
  for (const entry of plan.fileSync) {
    const key = `${entry.session.service}/${entry.session.mountKey}`;
    if (
      plannedKeys.has(key) ||
      !expected.some(
        (mount) => mount.service === entry.session.service && mount.mountKey === entry.session.mountKey,
      )
    )
      return false;
    plannedKeys.add(key);
  }
  const seen = new Set<string>();
  return sessions.every((session) => {
    const key = `${session.service}/${session.mountKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const mount = expected.find(
      (candidate) => candidate.service === session.service && candidate.mountKey === session.mountKey,
    );
    if (mount === undefined) return false;
    const expectedExcludes = mount.excludes;
    return (
      session.app.kind === "user" &&
      session.app.id === plan.id &&
      pathEquals(session.app.root, plan.root) &&
      session.permissions === undefined &&
      pathEquals(session.source, mount.source) &&
      session.mode === "two-way-safe" &&
      session.excludes.length === expectedExcludes.length &&
      session.excludes.every((exclude, index) => exclude === expectedExcludes[index]) &&
      session.target._tag === "volume" &&
      session.target.name === mount.volumeName &&
      session.target.path === mount.targetPath
    );
  });
};
