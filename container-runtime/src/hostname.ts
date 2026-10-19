import { sha256Hex } from "@lando/sdk/digest";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";

export const CONTAINER_HOSTNAME_MAX_LENGTH = 63;
export const CONTAINER_HOSTNAME_HASH_LENGTH = 8;

const hostnameHash = (value: string): string => sha256Hex(value).slice(0, CONTAINER_HOSTNAME_HASH_LENGTH);

/**
 * Sanitize a raw `<app slug>-<service>` hostname into a single DNS label.
 * Lowercases, replaces any character outside `[a-z0-9-]` with `-`, collapses
 * repeats, trims leading/trailing `-`, and caps at 63 characters. Truncation
 * appends a short hash of the full sanitized name so distinct long names do
 * not collide.
 */
export const sanitizeContainerHostname = (raw: string): string => {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return hostnameHash(raw);
  if (cleaned.length <= CONTAINER_HOSTNAME_MAX_LENGTH) return cleaned;

  const hash = hostnameHash(cleaned);
  const budget = CONTAINER_HOSTNAME_MAX_LENGTH - hash.length - 1;
  const prefix = cleaned.slice(0, budget).replace(/-+$/g, "");
  return prefix.length === 0 ? hash : `${prefix}-${hash}`;
};

export const defaultContainerHostname = (slug: string, service: string): string =>
  sanitizeContainerHostname(`${slug}-${service}`);

/** Derived `<slug>-<service>` hostname used at create time. */
export const resolveContainerHostname = (
  plan: Pick<AppPlan, "slug">,
  service: Pick<ServicePlan, "name">,
): string => defaultContainerHostname(plan.slug, service.name);
