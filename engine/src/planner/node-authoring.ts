import { landofileValidationError } from "@lando/landofile/validation";
import type { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import type { FileSystem, ServiceType } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { isComposeBuild } from "../services/compose-build-artifact.ts";
import { hasCustomImage } from "./home.ts";
import { type PlannedProjectFile, loadServiceTypeProjectFiles } from "./project-files.ts";

export type AuthorizedProjectFileRequest = {
  readonly appRoot: string;
  readonly name: string;
  readonly service: ServiceConfig;
  readonly serviceType: ServiceType;
  readonly pinnedService: ServiceConfig;
  /** The catalog artifact tag the planner resolved, so it is not mistaken for an authored image. */
  readonly resolvedArtifactTag: string | undefined;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem> | undefined;
};

const landofileFailure = (
  appRoot: string,
  path: ReadonlyArray<string | number>,
  message: string,
  remediation: string,
) =>
  landofileValidationError(appRoot, [validationIssue(path, message, remediation)], {
    headline: "Landofile has invalid values",
    remediation,
  });

const isNodeServiceType = (id: string): boolean => id === "node" || id.startsWith("node:");

export const loadAuthorizedServiceProjectFiles = (
  input: AuthorizedProjectFileRequest,
): Effect.Effect<readonly PlannedProjectFile[], LandofileValidationError> => {
  const packageRoot = input.pinnedService.packageRoot;
  const node = isNodeServiceType(input.serviceType.id);
  if (packageRoot !== undefined && !node) {
    return Effect.fail(
      landofileFailure(
        input.appRoot,
        ["services", input.name, "packageRoot"],
        `Service ${input.name} may use packageRoot only with a Node service type.`,
        "Remove packageRoot or use a Node service type.",
      ),
    );
  }
  if (input.service.type === "node") {
    const replacementBuild = input.service.build !== undefined && isComposeBuild(input.service.build);
    if (input.service.image !== undefined || replacementBuild) {
      const authored = input.service.image === undefined ? "a Compose build" : "image";
      return Effect.fail(
        landofileFailure(
          input.appRoot,
          ["services", input.name, input.service.image === undefined ? "build" : "image"],
          `Service ${input.name} cannot combine bare type: node inference with ${authored}.`,
          "Remove it or use an explicit Node type.",
        ),
      );
    }
  }
  if (node && hasCustomImage(input.pinnedService, input.resolvedArtifactTag)) {
    if (packageRoot !== undefined) {
      return Effect.fail(
        landofileFailure(
          input.appRoot,
          ["services", input.name, "packageRoot"],
          `Service ${input.name} owns its toolchain through a custom image or build, so packageRoot is not allowed.`,
          "Remove packageRoot or use a catalog Node type.",
        ),
      );
    }
    return Effect.succeed([]);
  }
  return loadServiceTypeProjectFiles({
    appRoot: input.appRoot,
    serviceName: input.name,
    packageRoot: packageRoot ?? ".",
    declarations: input.serviceType.projectFiles?.(input.pinnedService) ?? [],
    fileSystem: input.fileSystem,
  });
};
