import {
  LandofileValidationError,
  ServiceFeatureError,
  type ServiceTypeCollisionError,
  ServiceTypeError,
} from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";

export const serviceTypeCollision = (
  appRoot: string,
  serviceName: string,
  error: ServiceTypeCollisionError,
): LandofileValidationError =>
  new LandofileValidationError({
    message: error.remediation === undefined ? error.message : `${error.message} ${error.remediation}`,
    remediation: error.remediation ?? "Remove or rename the conflicting service type registration.",
    file: `${appRoot}/.lando.yml`,
    issues: [
      validationIssue(
        ["services", serviceName, "type"],
        error.remediation === undefined ? error.message : `${error.message} ${error.remediation}`,
      ),
    ],
  });

export const servicePlanError = (appRoot: string, serviceName: string, cause: unknown) => {
  if (cause instanceof LandofileValidationError) return cause;
  return new LandofileValidationError({
    message: cause instanceof Error ? cause.message : `Invalid service ${serviceName}.`,
    remediation:
      cause instanceof ServiceTypeError || cause instanceof ServiceFeatureError
        ? cause.remediation
        : `Correct the configuration of service ${serviceName}.`,
    file: `${appRoot}/.lando.yml`,
    issues:
      (cause instanceof ServiceTypeError || cause instanceof ServiceFeatureError) &&
      cause.issues !== undefined &&
      cause.issues.length > 0
        ? cause.issues.map((issue) => ({ ...issue, path: ["services", serviceName, ...issue.path] }))
        : [
            validationIssue(
              ["services", serviceName],
              cause instanceof Error ? cause.message : `Invalid service ${serviceName}.`,
            ),
          ],
  });
};
