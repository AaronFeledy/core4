import type { ServiceConfig } from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { resolveHomePath, serviceHomeIntent } from "./home.ts";
import { loadServiceTypeWithVersion, resolvePinnedArtifactTag, serviceTypeFor } from "./service-types.ts";

export type ServiceHomeAssessment =
  | { readonly kind: "persisted"; readonly target: string }
  | {
      readonly kind: "not-persisted";
      readonly reason: "custom-image" | "no-identity" | "undeclared-user";
      readonly user?: string;
    }
  | { readonly kind: "unresolved"; readonly reason: string };

/** Catalog-only estimate: features may change the user during actual planning. */
export const assessServiceHome = Effect.fn("ServiceHome.assess")(function* (
  registry: Context.Service.Shape<typeof PluginRegistry>,
  name: string,
  service: ServiceConfig,
): Effect.fn.Return<ServiceHomeAssessment> {
  for (const key of ["type", "image", "user"] as const) {
    if (service[key]?.includes("{{")) return { kind: "unresolved", reason: `${key} is expression-valued` };
  }
  if (service.home === false)
    return { kind: "unresolved", reason: "home persistence is explicitly disabled" };
  const reference = serviceTypeFor(name, service);
  return yield* Effect.gen(function* () {
    const { serviceType, version } = yield* loadServiceTypeWithVersion(registry, reference);
    const pinnedArtifactTag = yield* resolvePinnedArtifactTag("", name, serviceType, version);
    const intent = serviceHomeIntent({
      service,
      serviceTypeId: serviceType.id,
      identity: serviceType.identity,
      pinnedArtifactTag,
    });
    const user = service.user ?? intent.identity?.defaultUser;
    const principal = user?.split(":")[0];
    const target = resolveHomePath({ serviceName: name, intent, plannedUser: principal });
    if (target !== undefined) return { kind: "persisted", target } as const;
    return {
      kind: "not-persisted",
      reason: intent.customImage
        ? "custom-image"
        : intent.identity === undefined
          ? "no-identity"
          : "undeclared-user",
      ...(principal === undefined ? {} : { user: principal }),
    } as const;
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({
        kind: "unresolved",
        reason: `service type ${reference} could not be resolved`,
      } as const),
    ),
  );
});
