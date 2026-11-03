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
  const servicePart = segment(service, Math.max(HASH_LENGTH, budget - slug.length)) || "x";
  const slugPart = segment(slug, budget - servicePart.length) || "x";
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
