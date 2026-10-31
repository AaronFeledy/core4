import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, PortablePath, type VolumeMountPlan } from "@lando/sdk/schema";
import type { EphemeralBindMount, EphemeralRunSpec } from "@lando/sdk/services";

import { posixCovers, posixJoin } from "./sqlite-path.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlanMount, SqlPlanService } from "./views.ts";

export type SqliteCoveringMount =
  | { readonly kind: "bind"; readonly source: string; readonly target: string; readonly readOnly: boolean }
  | { readonly kind: "volume"; readonly store: string; readonly target: string; readonly readOnly: boolean };

const targetDepth = (target: string): number =>
  target.split("/").filter((segment) => segment.length > 0).length;

export const sqliteContainerPath = (service: SqlPlanService, target: SqlFileTarget): string | undefined => {
  const appMount = service.mounts.find((mount) => mount.type === "bind" && mount.role === "app");
  if (appMount === undefined) return undefined;
  return posixJoin(appMount.target, target.path);
};

export const coveringSqliteMount = (
  service: SqlPlanService,
  filePath: string,
): SqliteCoveringMount | { readonly kind: "tmpfs"; readonly target: string } | undefined => {
  let match: SqlPlanMount | undefined;
  for (const mount of service.mounts) {
    if (!posixCovers(mount.target, filePath)) continue;
    if (match === undefined || targetDepth(mount.target) >= targetDepth(match.target)) match = mount;
  }
  if (match === undefined) return undefined;
  if (match.type === "tmpfs") return { kind: "tmpfs", target: match.target };
  if (match.type === "bind") {
    return { kind: "bind", source: match.source, target: match.target, readOnly: match.readOnly };
  }
  return { kind: "volume", store: match.store, target: match.target, readOnly: match.readOnly };
};

export const requireSqliteCoveringMount = (
  service: SqlPlanService,
  target: SqlFileTarget,
): SqliteCoveringMount | SqlRecoveryUnavailableError => {
  const filePath = sqliteContainerPath(service, target);
  if (filePath === undefined) {
    return new SqlRecoveryUnavailableError({
      message: `Service ${target.name} has no app mount covering SQLite path ${target.path}.`,
      service: target.name,
      reason: "The SQLite file is relative to the service app mount, and this service has no app mount.",
      remediation: "Set an app mount on the service, or move sqlite.path onto a service that mounts the app.",
    });
  }
  const covering = coveringSqliteMount(service, filePath);
  if (covering === undefined) {
    return new SqlRecoveryUnavailableError({
      message: `No planned mount covers SQLite file ${filePath} on ${target.name}.`,
      service: target.name,
      reason: "The helper can only see bind or named-volume mounts from the applied plan.",
      remediation: "Rebuild the app so the SQLite path is on the app mount or an exclude volume, then retry.",
    });
  }
  if (covering.kind === "tmpfs") {
    return new SqlRecoveryUnavailableError({
      message: `SQLite file ${filePath} is on a tmpfs mount at ${covering.target}.`,
      service: target.name,
      reason: "A memory-backed mount cannot hold a durable SQLite database.",
      remediation: "Move sqlite.path off the tmpfs mount, then retry.",
    });
  }
  if (covering.readOnly) {
    return new SqlRecoveryUnavailableError({
      message: `SQLite file ${filePath} is on a read-only mount at ${covering.target}.`,
      service: target.name,
      reason: "Import, reset, snapshot, and restore need a writable covering mount.",
      remediation: "Mount the SQLite path read-write, then retry.",
    });
  }
  return covering;
};

/** Accept only ownership returned by the read-only helper inspection. */
export const sqliteHelperUser = (ownership: string): string | undefined => {
  const user = ownership.trim();
  if (!/^\d+:\d+$/u.test(user)) return undefined;
  const [uid, gid] = user.split(":").map(Number);
  return Number.isSafeInteger(uid) && Number.isSafeInteger(gid) ? user : undefined;
};

export const sqliteHelperAccess = (
  covering: SqliteCoveringMount,
  applied: AppPlan,
  scratch?: { readonly source: string; readonly target: string },
): {
  readonly mounts?: ReadonlyArray<VolumeMountPlan>;
  readonly binds: ReadonlyArray<EphemeralBindMount>;
  readonly owner?: EphemeralRunSpec["owner"];
} => {
  const scratchBinds: ReadonlyArray<EphemeralBindMount> =
    scratch === undefined ? [] : [{ source: scratch.source, target: scratch.target }];
  if (covering.kind === "bind") {
    return {
      binds: [
        { source: covering.source, target: covering.target, readOnly: covering.readOnly },
        ...scratchBinds,
      ],
    };
  }
  return {
    owner: { app: applied.id, plan: applied },
    mounts: [
      {
        type: "volume",
        store: covering.store,
        target: PortablePath.make(covering.target),
        readOnly: covering.readOnly,
      },
    ],
    binds: scratchBinds,
  };
};
