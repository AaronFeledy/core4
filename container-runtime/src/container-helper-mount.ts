import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError } from "@lando/sdk/errors";
import { type AppPlan, PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  CONTAINER_HELPER_COMMAND_TARGETS,
  containerHelperCommandMounts,
  containerHelperDelivery,
} from "./container-helper.ts";
import type { ExecSupervisionOptions } from "./exec-supervision.ts";

export const prepareContainerHelperMounts = Effect.fn("RuntimeProvider.prepareContainerHelperMounts")(
  function* (
    plan: AppPlan,
    options: Pick<ExecSupervisionOptions, "ctx" | "resolveContainerHelper" | "helperTarget">,
  ) {
    if (Object.keys(plan.services).length === 0) return plan;
    const { resolveContainerHelper, helperTarget } = options;
    const failure = (message: string, remediation: string, cause?: unknown) =>
      new ProviderInternalError({
        providerId: options.ctx.providerId,
        operation: "apply",
        message,
        remediation,
        ...(cause === undefined ? {} : { cause }),
      });
    if (resolveContainerHelper === undefined || helperTarget === undefined)
      return yield* Effect.fail(
        failure(
          "The service container helper is unavailable.",
          "Check the provider architecture and reinstall Lando's container helper.",
        ),
      );
    const helper = yield* resolveContainerHelper(helperTarget).pipe(
      mapFailures((cause) => failure(cause.message, cause.remediation, cause)),
    );
    const delivery = containerHelperDelivery(helper);
    const commandMounts = containerHelperCommandMounts(helper).map((mount) => ({
      type: "bind" as const,
      origin: "integration" as const,
      source: mount.source,
      target: PortablePath.make(mount.target),
      readOnly: true,
      realization: "passthrough" as const,
    }));
    const services: AppPlan["services"] = Object.fromEntries(
      Object.entries(plan.services).map(([name, service]) => [
        name,
        {
          ...service,
          mounts: [
            ...service.mounts,
            {
              type: "bind" as const,
              origin: "integration" as const,
              source: delivery.source,
              target: PortablePath.make(delivery.target),
              readOnly: true,
              realization: "passthrough" as const,
            },
            ...commandMounts,
          ],
        },
      ]),
    );
    for (const service of Object.values(plan.services)) {
      for (const target of [delivery.target, ...CONTAINER_HELPER_COMMAND_TARGETS]) {
        if (service.mounts.some((mount) => mount.target === target))
          return yield* Effect.fail(
            failure(
              `Service ${service.name} mounts the reserved helper target ${target}.`,
              `Remove the authored mount at ${target} and retry lando start.`,
            ),
          );
      }
    }
    return { ...plan, services };
  },
);
