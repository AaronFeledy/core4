import { resolve } from "node:path";
import { primaryIssueFile } from "@lando/landofile/validation";
import {
  LandofileValidationError,
  PluginLoadError,
  ServiceFeatureError,
  type ServiceTypeCollisionError,
  ServiceTypeError,
} from "@lando/sdk/errors";
import { type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { endpointDeclarationValidationError } from "../services/endpoint-declaration.ts";

export const serviceTypeCollision = (
  appRoot: string,
  serviceName: string,
  error: ServiceTypeCollisionError,
): LandofileValidationError =>
  new LandofileValidationError({
    message: error.remediation === undefined ? error.message : `${error.message} ${error.remediation}`,
    remediation: error.remediation ?? "Remove or rename the conflicting service type registration.",
    file: appRoot,
    issues: [
      validationIssue(
        ["services", serviceName, "type"],
        error.remediation === undefined ? error.message : `${error.message} ${error.remediation}`,
      ),
    ],
  });

/**
 * Resolve a service-type's project-file reference against the files the planner actually read.
 * The service type names an app-root-relative file; the planner owns containment and the absolute
 * path, so an undeclared file falls back to authored attribution instead of naming an unread path.
 */
const attributeProjectFileIssue = (
  appRoot: string,
  issue: ValidationIssue,
  projectFiles: ReadonlyArray<ServiceTypeProjectFileInput> | undefined,
): ValidationIssue => {
  const source = issue.source;
  if (source === undefined || source.layer !== "project-file") return issue;
  const declared = projectFiles?.find(
    (file) => resolve(appRoot, file.path) === resolve(appRoot, source.file),
  );
  if (declared === undefined) {
    const { source: _unverified, ...withoutSource } = issue;
    return withoutSource;
  }
  return { ...issue, source: { ...source, file: resolve(appRoot, declared.path) } };
};

export interface ServicePlanErrorInput {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly cause: unknown;
  /** Project files the planner read for this service, when its type resolves from them. */
  readonly projectFiles?: ReadonlyArray<ServiceTypeProjectFileInput>;
}

export const servicePlanError = ({ appRoot, serviceName, cause, projectFiles }: ServicePlanErrorInput) => {
  if (cause instanceof LandofileValidationError) return cause;
  const declaration = endpointDeclarationValidationError(appRoot, cause);
  if (declaration !== undefined) return declaration;
  const remediation =
    cause instanceof ServiceTypeError ||
    cause instanceof ServiceFeatureError ||
    cause instanceof PluginLoadError
      ? cause.remediation
      : undefined;
  const issues: ReadonlyArray<ValidationIssue> =
    (cause instanceof ServiceTypeError || cause instanceof ServiceFeatureError) &&
    cause.issues !== undefined &&
    cause.issues.length > 0
      ? cause.issues.map((issue) => {
          const attributed = attributeProjectFileIssue(appRoot, issue, projectFiles);
          return {
            ...attributed,
            path: ["services", serviceName, ...attributed.path],
            suggestion: attributed.suggestion ?? cause.remediation,
          };
        })
      : [
          validationIssue(
            ["services", serviceName],
            cause instanceof Error ? cause.message : `Invalid service ${serviceName}.`,
            remediation,
          ),
        ];
  return new LandofileValidationError({
    message: cause instanceof Error ? cause.message : `Invalid service ${serviceName}.`,
    remediation: remediation ?? `Correct the configuration of service ${serviceName}.`,
    file: primaryIssueFile(issues, appRoot),
    issues,
  });
};
