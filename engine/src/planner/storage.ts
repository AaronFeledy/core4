import { LandofileValidationError, NotImplementedError } from "@lando/sdk/errors";
import {
  type DataStoreMountPlan,
  PortablePath,
  type ServiceConfig,
  type ServicePlan,
  type StorageScope,
} from "@lando/sdk/schema";

import { kebab, shortHash } from "./naming.ts";
import type { AuthoredStorageInfo } from "./service-types.ts";

const GLOBAL_SCOPE_REMEDIATION =
  "Use scope: app or scope: service. Storage scope: global is deferred until global app support lands.";

const cacheStorageKey = (target: string, key: string | undefined): string => key ?? kebab(target);

const cacheStoreName = (target: string, key: string | undefined): string =>
  `lando-cache-${cacheStorageKey(target, key)}`;

export const authoredStorageScopes = (
  appRoot: string,
  serviceName: string,
  service: ServiceConfig,
): {
  byStore: Map<string, AuthoredStorageInfo>;
  globalEntry?: { index: number; store?: string };
  invalidCacheEntry?: LandofileValidationError;
} => {
  const byStore = new Map<string, AuthoredStorageInfo>();
  const entries = service.storage ?? [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string") continue;
    if (entry.kind === "cache" && entry.scope === "service") {
      return {
        byStore,
        invalidCacheEntry: new LandofileValidationError({
          message: `Service ${serviceName} declares kind: cache with scope: service at services.${serviceName}.storage[${index}] in ${appRoot}/.lando.yml. Cache storage is shared across apps by design.`,
          file: `${appRoot}/.lando.yml`,
          issues: [`services.${serviceName}.storage[${index}].scope`],
        }),
      };
    }
    const kind = entry.kind ?? "data";
    const key = kind === "cache" ? cacheStorageKey(entry.target, entry.key) : entry.key;
    const storeName = kind === "cache" ? cacheStoreName(entry.target, entry.key) : entry.store;
    const scope = entry.scope ?? "service";
    if (scope === "global" && kind !== "cache") {
      return { byStore, globalEntry: { index, store: entry.store } };
    }
    byStore.set(storeName, {
      scope: kind === "cache" ? "global" : scope,
      kind,
      ...(key === undefined ? {} : { key }),
    });
  }
  return { byStore };
};

const storageMountTargetKey = (target: PortablePath): string => String(target);

export const applyAuthoredStorage = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authored = service.storage ?? [];
  if (authored.length === 0) return servicePlan;
  const occupiedTargets = new Set(servicePlan.storage.map((mount) => storageMountTargetKey(mount.target)));
  const additions: DataStoreMountPlan[] = [];
  for (const entry of authored) {
    const target = typeof entry === "string" ? entry : entry.target;
    const mountTarget = PortablePath.make(target);
    const targetKey = storageMountTargetKey(mountTarget);
    if (occupiedTargets.has(targetKey)) continue;
    occupiedTargets.add(targetKey);
    let store: string;
    if (typeof entry === "string") {
      store = kebab(target);
    } else if (entry.kind === "cache") {
      store = cacheStoreName(target, entry.key);
    } else {
      store = entry.store;
    }
    additions.push({
      store,
      target: mountTarget,
      readOnly: typeof entry === "string" ? false : (entry.readOnly ?? false),
    });
  }
  if (additions.length === 0) return servicePlan;
  return { ...servicePlan, storage: [...servicePlan.storage, ...additions] };
};

export const rejectGlobalScope = (
  appRoot: string,
  serviceName: string,
  entry: { index: number; store?: string },
): NotImplementedError =>
  new NotImplementedError({
    message: `Service ${serviceName} declares storage scope: global at services.${serviceName}.storage[${entry.index}]${entry.store ? ` (store ${entry.store})` : ""} in ${appRoot}/.lando.yml.`,
    commandId: "landofile.parse",
    remediation: GLOBAL_SCOPE_REMEDIATION,
  });

const joinPathSegments = (target: string, exclude: string): string => {
  const normalizedTarget = target.endsWith("/") ? target.slice(0, -1) : target;
  const normalizedExclude = exclude.startsWith("/") ? exclude.slice(1) : exclude;
  return `${normalizedTarget}/${normalizedExclude}`;
};

export const expandExcludesToShadows = (
  appName: string,
  serviceName: string,
  servicePlan: ServicePlan,
): {
  servicePlan: ServicePlan;
  shadowStores: ReadonlyArray<{ name: string; scope: StorageScope }>;
} => {
  const appMount = servicePlan.appMount;
  if (appMount === undefined) return { servicePlan, shadowStores: [] };
  const excludes = appMount.excludes ?? [];
  const includes = new Set(appMount.includes ?? []);
  const effectiveExcludes = excludes.filter((entry) => !entry.startsWith("!") && !includes.has(entry));
  if (effectiveExcludes.length === 0) return { servicePlan, shadowStores: [] };

  const shadowStores: Array<{ name: string; scope: StorageScope }> = [];
  const shadowStoreNames = new Set<string>();
  const shadowMounts: Array<{
    readonly store: string;
    readonly target: PortablePath;
    readonly readOnly: boolean;
  }> = [];

  for (const excludePath of effectiveExcludes) {
    const destination = joinPathSegments(appMount.target, excludePath);
    const storeName = `${appName}-${serviceName}-${kebab(destination)}-${shortHash(destination)}`;
    if (!shadowStoreNames.has(storeName)) {
      shadowStoreNames.add(storeName);
      shadowStores.push({ name: storeName, scope: "service" });
    }
    shadowMounts.push({ store: storeName, target: PortablePath.make(destination), readOnly: false });
  }

  const nextPlan: ServicePlan = {
    ...servicePlan,
    storage: [...servicePlan.storage, ...shadowMounts],
  };
  return { servicePlan: nextPlan, shadowStores };
};
