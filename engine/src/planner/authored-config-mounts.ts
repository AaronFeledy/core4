import { LandofileValidationError } from "@lando/sdk/errors";
import type { BindMountPlan, ServiceConfig, ValidationIssuePath } from "@lando/sdk/schema";
import {
  type MountAuthoringContext,
  bindSource,
  isAppRelativeSource,
  mountInputError,
} from "./authored-mount-entry.ts";
import { plannedContainerDestination } from "./storage.ts";

/** Compile grants without reading files; the plan's config-file loader owns the single content read. */
export const compileConfigMounts = (
  context: MountAuthoringContext,
  grants: ServiceConfig["configs"],
):
  | readonly { readonly mount: BindMountPlan; readonly path: ValidationIssuePath }[]
  | LandofileValidationError => {
  const mounts: Array<{ readonly mount: BindMountPlan; readonly path: ValidationIssuePath }> = [];
  for (const [index, grant] of (grants ?? []).entries()) {
    const path = ["services", context.serviceName, "configs", index];
    const definition = grant.source === undefined ? undefined : context.configs?.[grant.source];
    if (definition?.file === undefined || definition.file.length === 0 || definition.external === true)
      return mountInputError(
        context,
        [path, ["configs", grant.source ?? ""]],
        `Service ${context.serviceName} requires a file-backed Compose config ${grant.source ?? ""}.`,
        "Define configs.<name>.file and reference that name in the grant; external configs are not supported.",
      );
    const target = plannedContainerDestination(grant.target ?? `/${grant.source}`, context.appRoot, path);
    if (target instanceof LandofileValidationError) return target;
    const fileMode = typeof grant.mode === "string" ? Number.parseInt(grant.mode, 8) : grant.mode;
    if (
      fileMode !== undefined &&
      (!Number.isInteger(fileMode) ||
        fileMode < 0 ||
        fileMode > 0o7777 ||
        (typeof grant.mode === "string" && !/^[0-7]+$/u.test(grant.mode)))
    )
      return mountInputError(
        context,
        [[...path, "mode"]],
        "Compose config mode must be an integer permission mode or an octal string between 0000 and 7777.",
        "Use a numeric permission mode or an octal string such as 0444.",
      );
    mounts.push({
      path,
      mount: {
        type: "bind",
        origin: "authored",
        source: bindSource(definition.file, context.appRoot),
        ...(isAppRelativeSource(definition.file) ? { relativeTo: "app" } : {}),
        target,
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
        ...(fileMode === undefined ? {} : { fileMode }),
      },
    });
  }
  return mounts;
};
