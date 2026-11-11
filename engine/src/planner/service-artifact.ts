import { ServiceTypeError } from "@lando/sdk/errors";
import type { AppPlan, PluginManifest, ServicePlan } from "@lando/sdk/schema";
import { type PlannedServiceDraft, contributionId } from "./service-types.ts";

/** Compose builds replace the base; an authored image fills only a missing feature artifact. The authored pull policy travels with the artifact it governs. */
export const resolveServiceArtifact = (
  plan: ServicePlan,
  entry: PlannedServiceDraft,
  manifests: readonly PluginManifest[],
): ServicePlan | ServiceTypeError => {
  const artifact =
    entry.authoredArtifact?.kind === "build"
      ? entry.authoredArtifact
      : (plan.artifact ?? entry.authoredArtifact);
  if (artifact !== undefined)
    return { ...plan, artifact, ...(entry.pullPolicy === undefined ? {} : { pullPolicy: entry.pullPolicy }) };
  const serviceType = plan.serviceTypeId ?? entry.draft.serviceType;
  const plugin = manifests.find((manifest) =>
    manifest.contributes?.serviceTypes?.some((type) => contributionId(type) === serviceType),
  );
  const message = `Service ${entry.name} of type ${serviceType}${plugin === undefined ? "" : ` from plugin ${plugin.name}`} has no artifact.`;
  const remediation = `Set image: to a container image reference or build: to a Compose build context for service ${entry.name}, or have service type ${serviceType} request a feature that sets an artifact with setArtifact.`;
  return new ServiceTypeError({
    serviceType,
    message,
    remediation,
    issues: [{ path: ["type"], message, suggestion: remediation }],
  });
};

/** A plan cached before artifact validation may hold a service no provider can pull or build. */
export const hasServiceArtifacts = (plan: AppPlan): boolean =>
  Object.values(plan.services).every((service) => service.artifact !== undefined);
