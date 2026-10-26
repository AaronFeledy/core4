import { LandofileValidationError, NotImplementedError } from "@lando/sdk/errors";
import {
  type PortablePath,
  type ServiceConfig,
  containerDestinationRefusalMessage,
  parseContainerDestination,
} from "@lando/sdk/schema";

import { type ValidationIssuePath, validationIssue } from "@lando/sdk/schema";
import { kebab } from "./naming.ts";
import type { AuthoredStorageInfo } from "./service-types.ts";

const GLOBAL_SCOPE_REMEDIATION =
  "Use scope: app or scope: service. Storage scope: global is deferred until global app support lands.";

const cacheStorageKey = (target: string, key: string | undefined): string => key ?? kebab(target);

/** Cache stores are named from the canonical destination so every reader derives one name. */
export const cacheStoreName = (target: string, key: string | undefined): string =>
  `lando-cache-${cacheStorageKey(target, key)}`;

export const plannedContainerDestination = (
  target: string,
  appRoot: string,
  issue: ValidationIssuePath,
): PortablePath | LandofileValidationError => {
  const parsed = parseContainerDestination(target);
  if (!parsed.ok) {
    return new LandofileValidationError({
      message: containerDestinationRefusalMessage(parsed.reason, target),
      remediation: "Use an absolute in-container destination without parent traversal.",
      file: `${appRoot}/.lando.yml`,
      issues: [validationIssue(issue, containerDestinationRefusalMessage(parsed.reason, target))],
    });
  }
  return parsed.value;
};

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
          remediation: "Remove scope: service from cache storage; caches are shared across apps.",
          file: `${appRoot}/.lando.yml`,
          issues: [
            validationIssue(
              ["services", serviceName, "storage", index, "scope"],
              `Service ${serviceName} declares kind: cache with scope: service at services.${serviceName}.storage[${index}] in ${appRoot}/.lando.yml. Cache storage is shared across apps by design.`,
            ),
          ],
        }),
      };
    }
    const kind = entry.kind ?? "data";
    const destination = parseContainerDestination(entry.target);
    const target = destination.ok ? destination.value : entry.target;
    const key = kind === "cache" ? cacheStorageKey(target, entry.key) : entry.key;
    const storeName = kind === "cache" ? cacheStoreName(target, entry.key) : entry.store;
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
