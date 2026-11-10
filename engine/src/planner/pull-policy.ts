import { LandofileValidationError } from "@lando/sdk/errors";
import { type ServiceConfig, type ServicePullPolicy, validationIssue } from "@lando/sdk/schema";

import { isComposeBuild } from "../services/compose-build-artifact.ts";

type AuthoredPullPolicy = NonNullable<ServiceConfig["pull_policy"]>;

const knownPolicy = (
  value: AuthoredPullPolicy,
): ServicePullPolicy | "missing" | "if_not_present" | undefined => {
  switch (value) {
    case "always":
    case "never":
    case "build":
    case "missing":
    case "if_not_present":
      return value;
    default:
      return undefined;
  }
};

/** Canonical acquisition intent; omitted means pull only a missing image (the Compose default). */
export const servicePullPolicy = (service: ServiceConfig): ServicePullPolicy | undefined => {
  const policy = service.pull_policy === undefined ? undefined : knownPolicy(service.pull_policy);
  return policy === "missing" || policy === "if_not_present" ? undefined : policy;
};

const pullPolicyError = (
  file: string,
  serviceName: string,
  problem: { readonly message: string; readonly remediation: string },
) =>
  new LandofileValidationError({
    message: problem.message,
    file,
    remediation: problem.remediation,
    issues: [
      {
        ...validationIssue(["services", serviceName, "pull_policy"], problem.message),
        suggestion: problem.remediation,
      },
    ],
  });

const pullPolicyProblem = (service: ServiceConfig, serviceName: string, value: AuthoredPullPolicy) => {
  const policy = knownPolicy(value);
  const composeBuild = service.build !== undefined && isComposeBuild(service.build);
  if (policy === undefined)
    return {
      message: `Service ${serviceName} sets pull_policy: ${value}, but Lando does not refresh images on a timer.`,
      remediation: `Set pull_policy: always on service ${serviceName} to check the registry on every start, or remove it and run lando rebuild to refresh the image.`,
    };
  if ((policy === "always" || policy === "never") && composeBuild)
    return {
      message: `Service ${serviceName} sets pull_policy: ${policy} together with build:, but the build replaces the service image.`,
      remediation: `Set pull_policy: build on service ${serviceName} to build on every start, remove pull_policy, or remove build: to use a pulled image.`,
    };
  if (policy === "build" && !composeBuild)
    return {
      message: `Service ${serviceName} sets pull_policy: build but has no Compose build: section.`,
      remediation: `Add a build: section with a context to service ${serviceName}, or use pull_policy: always or never for its image.`,
    };
  return undefined;
};

export const validateServicePullPolicy = (
  service: ServiceConfig,
  serviceName: string,
  file: string,
): LandofileValidationError | undefined => {
  if (service.pull_policy === undefined) return undefined;
  const problem = pullPolicyProblem(service, serviceName, service.pull_policy);
  return problem === undefined ? undefined : pullPolicyError(file, serviceName, problem);
};
