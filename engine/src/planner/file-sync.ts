import type { AppId } from "@lando/sdk/schema";
import {
  AbsolutePath,
  type FileSyncPlan,
  type FileSyncSessionSpec,
  ServiceName,
  type ServicePlan,
  fileSyncVolumeName,
  sameAppMountTarget,
} from "@lando/sdk/schema";

import { type ContributionRef, contributionId } from "./service-types.ts";

export const FILE_SYNC_DEFAULT_EXCLUDES: ReadonlyArray<string> = ["node_modules", "vendor", ".git", "tmp"];

export const mergeDefaultExcludes = (servicePlan: ServicePlan): ServicePlan => {
  const appMount = servicePlan.appMount;
  if (appMount === undefined) return servicePlan;
  const merged = [...new Set([...FILE_SYNC_DEFAULT_EXCLUDES, ...(appMount.excludes ?? [])])];
  return { ...servicePlan, appMount: { ...appMount, excludes: merged } };
};

export const collectFileSyncEntries = (params: {
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appName: string;
  readonly serviceName: string;
  readonly servicePlan: ServicePlan;
  readonly engineId: string;
}): ReadonlyArray<FileSyncPlan> => {
  const { appId, appRoot, appName, serviceName, servicePlan, engineId } = params;
  const entries: Array<FileSyncPlan> = [];
  const app = { kind: "user" as const, id: appId, root: AbsolutePath.make(appRoot) };
  const branded = ServiceName.make(serviceName);
  const appMount = servicePlan.appMount;
  if (appMount !== undefined && appMount.realization === "accelerated") {
    const session: FileSyncSessionSpec = {
      app,
      service: branded,
      mountKey: "app-mount",
      source: appMount.source,
      target: {
        _tag: "volume",
        name: fileSyncVolumeName(appName, serviceName, "app-mount"),
        path: appMount.target,
      },
      mode: "two-way-safe",
      excludes: appMount.excludes,
    };
    entries.push({ engineId, session });
  }
  for (const [index, mount] of servicePlan.mounts.entries()) {
    if (mount.type !== "bind" || mount.realization !== "accelerated") continue;
    if (sameAppMountTarget(appMount, mount)) continue;
    const source = mount.source;
    if (source === undefined) continue;
    const mountKey = `mount-${index}`;
    const session: FileSyncSessionSpec = {
      app,
      service: branded,
      mountKey,
      source: AbsolutePath.make(source),
      target: {
        _tag: "volume",
        name: fileSyncVolumeName(appName, serviceName, mountKey),
        path: mount.target,
      },
      mode: "two-way-safe",
      excludes: [],
    };
    entries.push({ engineId, session });
  }
  return entries;
};

export const resolveFileSyncEngineId = (
  manifests: ReadonlyArray<{
    readonly contributes?:
      | { readonly fileSyncEngines?: ReadonlyArray<ContributionRef> | undefined }
      | undefined;
  }>,
): string | undefined => {
  for (const manifest of manifests) {
    const ids = (manifest.contributes?.fileSyncEngines ?? []).map(contributionId);
    if (ids.includes("mutagen")) return "mutagen";
  }
  for (const manifest of manifests) {
    const entry = (manifest.contributes?.fileSyncEngines ?? [])[0];
    if (entry !== undefined) return contributionId(entry);
  }
  return undefined;
};
