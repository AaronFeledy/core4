import { APP_ROOT_LABEL } from "@lando/container-runtime/labels";
import { serviceContainerOwnershipProblem } from "@lando/container-runtime/native-ownership";
import { AppResolveError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";

const claimsTeardownRoot = (service: ServiceRuntimeInfo, root: AbsolutePath): boolean =>
  service.appRoot === root || service.labels?.[APP_ROOT_LABEL] === root;

const orphanOwnershipRefusal = (input: {
  readonly providerId: string;
  readonly root: AbsolutePath;
  readonly service: ServiceRuntimeInfo;
  readonly label: string;
}): AppResolveError => {
  const container = input.service.containerId ?? "(no native id)";
  return new AppResolveError({
    message: `Container ${container} claims app root ${input.root} but its ${input.label} label does not prove ownership by app ${input.service.app} service ${input.service.service} on provider ${input.providerId}.`,
    reason: "mismatch",
    detail: "provider-resources",
    remediation: `Inspect container ${container} with your container runtime and restore its Lando ownership labels or remove it there before retrying teardown.`,
  });
};

export const refuseContradictoryOrphans = (input: {
  readonly root: AbsolutePath;
  readonly providers: ReadonlyArray<{ readonly id: string }>;
  readonly evidence: ReadonlyArray<{ readonly services: ReadonlyArray<ServiceRuntimeInfo> }>;
  readonly isProtected: (providerId: string, appId: string) => boolean;
}): Effect.Effect<void, AppResolveError> =>
  // A container that claims this root but cannot prove ownership is never silently absent.
  Effect.forEach(
    input.providers,
    (provider, index) => {
      const observed = input.evidence[index];
      if (observed === undefined) return Effect.void;
      return Effect.forEach(
        observed.services,
        (service) => {
          if (!claimsTeardownRoot(service, input.root)) return Effect.void;
          if (input.isProtected(provider.id, String(service.app))) return Effect.void;
          // An observation with no native id is an absent service, not a container to refuse.
          if (service.containerId === undefined) return Effect.void;
          const label = serviceContainerOwnershipProblem(service.labels, {
            app: String(service.app),
            appRoot:
              service.appRoot === undefined
                ? (service.labels?.[APP_ROOT_LABEL] ?? "")
                : String(service.appRoot),
            service: String(service.service),
            providerId: provider.id,
          });
          return label === undefined
            ? Effect.void
            : Effect.fail(
                orphanOwnershipRefusal({
                  providerId: provider.id,
                  root: input.root,
                  service,
                  label,
                }),
              );
        },
        { discard: true },
      );
    },
    { discard: true },
  );
