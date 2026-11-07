import { sha256Hex } from "../digest/index.ts";

const PREFIX = "lando-";
const DNS_LABEL_MAX_LENGTH = 63;
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
  segment(name, 57) || sha256Hex(appRoot).slice(0, HASH_LENGTH);

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

/** Cache keys deliberately share a namespace across apps. */
export const landoCacheStoreName = (key: string): string => `lando-cache-${canonicalOrHashed(key)}`;
