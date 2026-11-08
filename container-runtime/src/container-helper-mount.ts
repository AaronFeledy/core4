import { ProviderInternalError } from "@lando/sdk/errors";
import { type AppPlan, PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { containerHelperDelivery } from "./container-helper.ts";
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
      Effect.mapError((cause) => failure(cause.message, cause.remediation, cause)),
    );
    const delivery = containerHelperDelivery(helper);
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
          ],
        },
      ]),
    );
    for (const service of Object.values(plan.services)) {
      if (service.mounts.some((mount) => mount.target === delivery.target))
        return yield* Effect.fail(
          failure(
            `Service ${service.name} mounts the reserved helper target ${delivery.target}.`,
            "Remove the authored mount at /run/lando/helper and retry lando start.",
          ),
        );
    }
    return { ...plan, services };
  },
);
