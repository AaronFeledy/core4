import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type { FileSystem, ServiceType, ServiceTypeProjectFileInput } from "@lando/sdk/services";

import { loadServiceTypeProjectFiles } from "./project-files.ts";
import { unsupportedServiceType } from "./service-types.ts";

export type AuthorizedProjectFileRequest = {
  readonly appRoot: string;
  readonly name: string;
  readonly service: ServiceConfig;
  readonly serviceType: ServiceType;
  readonly serviceTypeId: string;
  readonly version: string | undefined;
  readonly pinnedService: ServiceConfig;
  readonly registeredServiceTypeIds: ReadonlyArray<string>;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
};

export const loadAuthorizedServiceProjectFiles = (
  input: AuthorizedProjectFileRequest,
): Effect.Effect<ReadonlyArray<ServiceTypeProjectFileInput>, LandofileValidationError> => {
  if (input.serviceType.id === "node" && input.version !== undefined) {
    return Effect.fail(
      unsupportedServiceType(input.appRoot, input.name, input.serviceTypeId, input.registeredServiceTypeIds),
    );
  }
  if (input.pinnedService.packageRoot !== undefined && input.serviceType.id !== "node") {
    return Effect.fail(
      new LandofileValidationError({
        message: `Service ${input.name} may use packageRoot only with bare type: node. Remove packageRoot or set type to node.`,
        file: `${input.appRoot}/.lando.yml`,
        issues: [`services.${input.name}.packageRoot`],
      }),
    );
  }
  if (input.service.type === "node" && input.service.image !== undefined) {
    return Effect.fail(
      new LandofileValidationError({
        message: `Service ${input.name} cannot combine bare type: node inference with image. Remove image or use an explicit Node type.`,
        file: `${input.appRoot}/.lando.yml`,
        issues: [`services.${input.name}.image`],
      }),
    );
  }
  return loadServiceTypeProjectFiles({
    appRoot: input.appRoot,
    serviceName: input.name,
    packageRoot: input.pinnedService.packageRoot ?? ".",
    declarations: input.serviceType.projectFiles?.(input.pinnedService) ?? [],
    fileSystem: input.fileSystem,
  });
};
