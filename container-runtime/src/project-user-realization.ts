/**
 * How a provider realizes a service's project user.
 *
 * The planner records the realization on the service because it is part of
 * what the container was created with, and the provider cannot recover it from
 * the identity alone: a keep-id plan and a renumbered plan can carry the same
 * numeric ids. Omission is the keep-id realization.
 */
import type { ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";

export const PROJECT_USER_MAPPING_EXTENSION_KEY = "@lando/core/project-user-mapping";

export type ProjectUserRealization = "userns-keep-id" | "image-renumber";

/** The realization recorded on a planned service; omission keeps the namespace mapping. */
export const serviceProjectUserMapping = (service: ServicePlan): ProjectUserRealization =>
  service.extensions[PROJECT_USER_MAPPING_EXTENSION_KEY] === "image-renumber"
    ? "image-renumber"
    : "userns-keep-id";

/** The realization a provider's declared capability selects. */
export const providerProjectUserMapping = (
  capabilities: Pick<ProviderCapabilities, "projectUserMapping">,
): ProjectUserRealization =>
  capabilities.projectUserMapping === "image-renumber" ? "image-renumber" : "userns-keep-id";
