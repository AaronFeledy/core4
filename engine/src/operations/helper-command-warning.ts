import { posix } from "node:path";
import {
  CONTAINER_HELPER_COMMAND_TARGETS,
  helperBindCoveredBy,
} from "@lando/container-runtime/container-helper";
import type { AppPlan, CommandWarning } from "@lando/sdk/schema";
import { HOST_PROXY_COMMAND_TARGETS } from "../subsystems/host-proxy/transport-feature.ts";
import { serviceHasHostProxyFeature } from "../subsystems/host-proxy/worker-service-plan.ts";

/**
 * One warning per service whose own mount covers the directory of Lando's in-container
 * commands. The provider and host-proxy overlay skip those binds rather than create
 * mountpoint files in that mount's source, so the commands are missing in the service.
 */
export const selectHelperCommandWarnings = (plan: AppPlan): readonly CommandWarning[] =>
  Object.values(plan.services).flatMap((service) => {
    const targets = [
      ...(serviceHasHostProxyFeature(service) ? HOST_PROXY_COMMAND_TARGETS : []),
      ...CONTAINER_HELPER_COMMAND_TARGETS,
    ];
    const covered = targets.flatMap((target) => {
      const mount = helperBindCoveredBy(service.mounts, target);
      return mount === undefined ? [] : [{ command: posix.basename(target), mount: mount.target }];
    });
    const [first] = covered;
    if (first === undefined) return [];
    const commands = covered.map(({ command }) => command).join(", ");
    return [
      {
        code: "LANDO_HELPER_COMMANDS_UNAVAILABLE",
        message: `Service ${service.name} mounts ${first.mount}, so Lando's ${commands} commands are not available in it.`,
        remediation: `Move the mount at ${first.mount} to another path to use these commands in ${service.name}.`,
        context: { service: service.name, mount: first.mount, commands },
      },
    ];
  });
