import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError } from "@lando/sdk/errors";
import { type AppPlan, PortablePath, mountTargetCovers } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  CONTAINER_HELPER_PROFILE_TARGET,
  containerHelperCommandMounts,
  containerHelperDelivery,
  containerHelperProfileStubPath,
  helperBindCoveredBy,
  reservedHelperTargetConflict,
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
    // Planning already refuses these for user plans; this guards plans built elsewhere.
    for (const service of Object.values(plan.services))
      for (const mount of service.mounts) {
        const conflict = reservedHelperTargetConflict(service.name, mount);
        if (conflict !== undefined)
          return yield* Effect.fail(failure(conflict.message, conflict.remediation));
      }
    const helper = yield* resolveContainerHelper(helperTarget).pipe(
      mapFailures((cause) => failure(cause.message, cause.remediation, cause)),
    );
    const delivery = containerHelperDelivery(helper);
    const bind = (source: string, target: string) => ({
      type: "bind" as const,
      origin: "integration" as const,
      source,
      target: PortablePath.make(target),
      readOnly: true,
      realization: "passthrough" as const,
    });
    const stub = bind(containerHelperProfileStubPath(helper), CONTAINER_HELPER_PROFILE_TARGET);
    const services: AppPlan["services"] = Object.fromEntries(
      Object.entries(plan.services).map(([name, service]) => [
        name,
        {
          ...service,
          mounts: [
            ...service.mounts,
            bind(delivery.source, delivery.target),
            // The engine warns once per service whose command binds a mount covers.
            ...containerHelperCommandMounts(helper)
              .filter((mount) => helperBindCoveredBy(service.mounts, mount.target) === undefined)
              .map((mount) => bind(mount.source, mount.target)),
            // The PATH stub is optional: a mount at its path or a bind or volume above it owns that path.
            ...(service.mounts.some(
              (mount) =>
                mountTargetCovers(mount.target, CONTAINER_HELPER_PROFILE_TARGET) &&
                mountTargetCovers(CONTAINER_HELPER_PROFILE_TARGET, mount.target),
            ) || helperBindCoveredBy(service.mounts, CONTAINER_HELPER_PROFILE_TARGET) !== undefined
              ? []
              : [stub]),
          ],
        },
      ]),
    );
    return { ...plan, services };
  },
);
