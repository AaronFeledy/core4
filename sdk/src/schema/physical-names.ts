import { sha256Hex } from "../digest/index.ts";

export const LANDO_DATA_ROOT_LABEL = "dev.lando.data-root" as const;
export const LANDO_NETWORK_ROLE_LABEL = "dev.lando.network-role" as const;
export const LANDO_SHARED_NETWORK_ROLE = "shared-cross-app" as const;

export const landoDataRootToken = (canonicalUserDataRoot: string): string =>
  sha256Hex(`data-root\0${canonicalUserDataRoot}`).slice(0, 16);

const sharedCrossAppPrefix = "lando_bridge_";
const dataRootTokenPattern = /^[a-f0-9]{16}$/u;

export const landoSharedCrossAppNetworkName = (canonicalUserDataRoot: string): string =>
  `${sharedCrossAppPrefix}${landoDataRootToken(canonicalUserDataRoot)}`;

export const isLandoScopedSharedNetworkName = (name: string): boolean =>
  name.startsWith(sharedCrossAppPrefix) && dataRootTokenPattern.test(name.slice(sharedCrossAppPrefix.length));

export const isLandoGlobalNativeSlug = (slug: string): boolean => /^global-[a-f0-9]{16}$/.test(slug);

/** Resolve a native naming coordinate without changing the logical slug or persisted data name. */
export const landoNativeAppSlug = (input: {
  readonly slug: string;
  readonly identity?: { readonly dataRoot?: string } | undefined;
  readonly dataSlug?: string;
}): string =>
  input.slug === "global"
    ? input.identity?.dataRoot === undefined
      ? "global"
      : `global-${landoDataRootToken(input.identity.dataRoot)}`
    : (input.dataSlug ?? input.slug);

export const landoDependencyEnvironmentStoreName = (dataSlug: string, kind: string, digest: string): string =>
  `lando-${segment(dataSlug, APP_SLUG_MAX_LENGTH)}--env--${segment(kind, 32)}-${digest.slice(0, 16)}`;

import { DOMAIN_NAME_PATTERN } from "./hostname.ts";

const PREFIX = "lando-";
const DNS_LABEL_MAX_LENGTH = 63;
/** Longest app slug: `lando-<slug>` must stay one DNS label. */
export const APP_SLUG_MAX_LENGTH = DNS_LABEL_MAX_LENGTH - PREFIX.length;
const HASH_LENGTH = 8;
/** Lowercase words joined by single hyphens: a DNS label that never contains `--`. */
const CANONICAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const segment = (value: string, maxLength: number): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, maxLength)
    .replace(/-+$/u, "");

/**
 * The container name of a planned service, which is also its hostname, so it is always one
 * lowercase DNS label of at most 63 characters.
 *
 * A canonical slug and service key join as `lando-<slug>--<service>`. Neither part contains
 * `--`, so the first `--` separates them and no two apps or services share a name. Any other
 * pair becomes `lando-<slug>--<service>--<hash>`, with both parts sanitized and shortened and a
 * hash of the original pair at the end. That form has two `--` where the canonical form has
 * one, so a fallback can never equal a canonical name.
 */
export const landoServiceContainerName = (slug: string, service: string): string => {
  const canonical = `${PREFIX}${slug}--${service}`;
  if (CANONICAL.test(slug) && CANONICAL.test(service) && canonical.length <= DNS_LABEL_MAX_LENGTH)
    return canonical;
  const budget = DNS_LABEL_MAX_LENGTH - PREFIX.length - "----".length - HASH_LENGTH;
  const slugPart = segment(slug, budget - HASH_LENGTH) || "x";
  const servicePart = segment(service, budget - slugPart.length) || "x";
  const hash = sha256Hex(`${slug}\0${service}`).slice(0, HASH_LENGTH);
  return `${PREFIX}${slugPart}--${servicePart}--${hash}`;
};

/**
 * A data store that belongs to one service, named after that service's container:
 * `lando-<slug>--<service>--<role>`. The role is sanitized to contain no `--`, so the last `--`
 * separates it from the container name.
 */
export const landoServiceStoreName = (slug: string, service: string, role: string): string =>
  `${landoServiceContainerName(slug, service)}--${segment(role, DNS_LABEL_MAX_LENGTH) || "data"}`;

/** Shared app slug normalization, including a root-derived name when no words remain. */
export const normalizeAppSlug = (name: string, appRoot: string): string =>
  segment(name, APP_SLUG_MAX_LENGTH) || sha256Hex(appRoot).slice(0, HASH_LENGTH);

export const defaultRouteHostname = (service: string, appSlug: string, domain: string): string => {
  const lower = service.toLowerCase();
  const servicePart = lower.split(".").every((label) => DOMAIN_NAME_PATTERN.test(label))
    ? lower
    : segment(service, DNS_LABEL_MAX_LENGTH) || sha256Hex(service).slice(0, HASH_LENGTH);
  return `${servicePart}.${appSlug}.${domain}`;
};

const canonicalOrHashed = (value: string): string =>
  CANONICAL.test(value) && value.length <= 64
    ? value
    : `${segment(value, 48) || "x"}--${sha256Hex(value).slice(0, HASH_LENGTH)}`;

/** A persisted home is distinct from service-type roles, even when its user is unknown. */
export const landoServiceHomeStoreName = (slug: string, service: string, principal?: string): string =>
  `${landoServiceContainerName(slug, service)}--home--${
    principal === undefined
      ? "default"
      : `${segment(principal, 32) || "user"}-${sha256Hex(`${service}\0${principal}`).slice(0, HASH_LENGTH)}`
  }`;

/** Excluded bind destinations get their own store; the digest preserves lossy path distinctions. */
export const landoServiceShadowStoreName = (slug: string, service: string, target: string): string =>
  `${landoServiceContainerName(slug, service)}--shadow--${segment(target, 48) || "shadow"}-${sha256Hex(target).slice(0, HASH_LENGTH)}`;

/** Anonymous authored storage belongs to one service and one exact destination. */
export const landoServiceStorageName = (slug: string, service: string, target: string): string =>
  `${landoServiceContainerName(slug, service)}--storage--${segment(target, 48) || "x"}-${sha256Hex(target).slice(0, HASH_LENGTH)}`;

/** Compose named sources share one app namespace, separate from container-derived stores. */
export const landoAppStoreName = (slug: string, source: string): string =>
  `${PREFIX}${slug}_${canonicalOrHashed(source)}`;

const CACHE_STORE_PREFIX = `${PREFIX}cache-`;
const GLOBAL_APP_VOLUME_PREFIX = `${PREFIX}global`;

/** Cache keys deliberately share a namespace across apps. */
export const landoCacheStoreName = (key: string): string => `${CACHE_STORE_PREFIX}${canonicalOrHashed(key)}`;

const HASH = /^[0-9a-f]{8}$/u;
const isCanonicalOrHashed = (name: string): boolean => {
  const [part = "", hash, ...extra] = name.split("--");
  return (
    extra.length === 0 &&
    CANONICAL.test(part) &&
    (hash === undefined ? part.length <= 64 : part.length <= 48 && HASH.test(hash))
  );
};

const isGlobalAppVolumeName = (name: string): boolean => {
  if (!name.startsWith(GLOBAL_APP_VOLUME_PREFIX)) return false;
  const candidate = name.slice(GLOBAL_APP_VOLUME_PREFIX.length);
  const scoped = /^-[a-f0-9]{16}(?=--|_)/.exec(candidate)?.[0] ?? "";
  const suffix = candidate.slice(scoped.length);
  if (suffix.startsWith("_")) return isCanonicalOrHashed(suffix.slice(1));
  if (!suffix.startsWith("--")) return false;
  const [service = "", ...parts] = suffix.slice(2).split("--");
  if (!CANONICAL.test(service)) return false;
  if (
    service === "env" &&
    parts.length === 1 &&
    /^[a-z0-9][a-z0-9-]{0,31}-[a-f0-9]{16}$/u.test(parts[0] ?? "")
  )
    return true;
  const containerLength = GLOBAL_APP_VOLUME_PREFIX.length + scoped.length + 2 + service.length;
  const hasRole = (role: ReadonlyArray<string>) => {
    const [kind = "", value = ""] = role;
    if (role.length === 1) return kind.length <= DNS_LABEL_MAX_LENGTH && CANONICAL.test(kind);
    if (role.length !== 2) return false;
    if (kind === "home" && value === "default") return true;
    const limit = kind === "home" ? 32 : kind === "shadow" || kind === "storage" ? 48 : 0;
    const segment = value.slice(0, -(HASH_LENGTH + 1));
    return (
      segment.length <= limit &&
      CANONICAL.test(segment) &&
      value.at(-(HASH_LENGTH + 1)) === "-" &&
      HASH.test(value.slice(-HASH_LENGTH))
    );
  };
  return (
    (containerLength <= DNS_LABEL_MAX_LENGTH && hasRole(parts)) ||
    (containerLength + 2 + HASH_LENGTH <= DNS_LABEL_MAX_LENGTH &&
      HASH.test(parts[0] ?? "") &&
      hasRole(parts.slice(1)))
  );
};

/**
 * Canonical physical-volume lock tier from the native volume name. Lower tiers
 * acquire first. Global-app volumes sit between ordinary app/service stores and
 * shared caches so a nested global ensure can take its keys while a user start
 * already holds tier-0 locks without inverting lock order.
 */
export const PHYSICAL_VOLUME_LOCK_TIER = {
  default: 0,
  globalApp: 1,
  cache: 2,
} as const;
export type PhysicalVolumeLockTier =
  (typeof PHYSICAL_VOLUME_LOCK_TIER)[keyof typeof PHYSICAL_VOLUME_LOCK_TIER];

export const physicalVolumeLockTier = (nativeName: string): PhysicalVolumeLockTier => {
  if (
    nativeName.startsWith(CACHE_STORE_PREFIX) &&
    isCanonicalOrHashed(nativeName.slice(CACHE_STORE_PREFIX.length))
  )
    return PHYSICAL_VOLUME_LOCK_TIER.cache;
  if (isGlobalAppVolumeName(nativeName)) return PHYSICAL_VOLUME_LOCK_TIER.globalApp;
  return PHYSICAL_VOLUME_LOCK_TIER.default;
};

/**
 * The canonical in-network alias of a planned service, which also names the
 * generated leaf certificate's common name. The router verifies and dials this
 * alias for managed backend TLS, so it is derived here once. `appSlug` is the
 * normalized app identity (`normalizeAppSlug`), not the raw authored name.
 */
export const serviceInternalAlias = (serviceName: string, appSlug: string): string =>
  `${serviceName}.${appSlug}.internal`;
