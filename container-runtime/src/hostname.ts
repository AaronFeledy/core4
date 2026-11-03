import { sha256Hex } from "@lando/sdk/digest";
import type { AppPlan } from "@lando/sdk/schema";

const HOSTNAME_MAX_LENGTH = 63;
const HASH_LENGTH = 8;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

/** Container name shared by every provider. `-` is in the allowed class, so sanitizing the joined name matches sanitizing slug and service separately. */
export const serviceContainerName = (plan: Pick<AppPlan, "slug">, service: string): string =>
  `lando-${plan.slug}-${service}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

/**
 * Engines register a container's hostname as a DNS name on every network it joins, so the hostname
 * reuses the container name they already register there. A name that is not one DNS label gets a
 * hash of the full name followed by a sanitized form of it. Leading hex digits keep that fallback
 * out of the `lando-` container-name namespace, and the hash keeps distinct names apart.
 */
export const serviceContainerHostname = (plan: Pick<AppPlan, "slug">, serviceName: string): string => {
  const name = serviceContainerName(plan, serviceName);
  if (DNS_LABEL.test(name)) return name;
  const readable = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, HOSTNAME_MAX_LENGTH - HASH_LENGTH - 1)
    .replace(/-+$/u, "");
  return `${sha256Hex(name).slice(0, HASH_LENGTH)}-${readable}`;
};
