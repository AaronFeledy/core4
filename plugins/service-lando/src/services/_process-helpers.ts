import type { ServiceFeatureContext } from "@lando/sdk/services";

type ProcessField = "command" | "entrypoint" | "workingDirectory" | "user";

/** Apply only present fields, in caller order; service-specific defaults stay at the caller. */
export const applyAuthoredProcessFields = (
  ctx: Pick<
    ServiceFeatureContext,
    "normalizedConfig" | "setCommand" | "setEntrypoint" | "setWorkingDirectory" | "setUser"
  >,
  fields: readonly ProcessField[] = ["command", "entrypoint", "workingDirectory", "user"],
): void => {
  const service = ctx.normalizedConfig;
  for (const field of fields) {
    switch (field) {
      case "command":
        if (service.command !== undefined) ctx.setCommand(service.command);
        break;
      case "entrypoint":
        if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
        break;
      case "workingDirectory":
        if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
        break;
      case "user":
        if (service.user !== undefined) ctx.setUser(service.user);
        break;
      default:
        field satisfies never;
    }
  }
};
