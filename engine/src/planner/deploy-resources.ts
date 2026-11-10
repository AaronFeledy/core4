import { resourceControlIssue } from "@lando/container-runtime/podman/compose-knobs";
import { LandofileValidationError } from "@lando/sdk/errors";
import { type ServiceConfig, validationIssue } from "@lando/sdk/schema";

/** Rejects deploy.resources values no container engine can realize, at the authored field. */
export const validateDeployResources = (
  service: ServiceConfig,
  serviceName: string,
  file: string,
): LandofileValidationError | undefined => {
  const issue = resourceControlIssue(service.deploy?.resources);
  if (issue === undefined) return undefined;
  const field = issue.field === undefined ? [] : issue.field.split(".");
  const remediation = `Set deploy.resources.${issue.field ?? "limits"} on service ${serviceName} to a value within the container engine's range, or remove it.`;
  return new LandofileValidationError({
    message: issue.message,
    file,
    remediation,
    issues: [
      {
        ...validationIssue(["services", serviceName, "deploy", "resources", ...field], issue.message),
        suggestion: remediation,
      },
    ],
  });
};
