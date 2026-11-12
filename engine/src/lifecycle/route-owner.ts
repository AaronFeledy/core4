import {
  type AbsolutePath,
  AppId,
  type AppPlan,
  type AppRouteOwner,
  appIdentityKey,
  planAppIdentity,
} from "@lando/sdk/schema";
import { SCRATCH_EXTENSION_KEY } from "../scratch-app/identity.ts";

export const routeOwnerFromScratch = (id: string): AppRouteOwner => ({
  id: AppId.make(id),
  ownerKey: appIdentityKey("owner", `scratch:${id}`),
});

/** Owner of routes published for a canonical app root when no applied plan records its identity. */
export const routeOwnerFromRoot = (id: string, canonicalRoot: AbsolutePath): AppRouteOwner => ({
  id: AppId.make(id),
  ownerKey: appIdentityKey("owner", canonicalRoot),
});

export const routeOwnerFromPlan = (
  plan: Pick<AppPlan, "id" | "root" | "identity" | "extensions">,
): AppRouteOwner =>
  Object.hasOwn(plan.extensions, SCRATCH_EXTENSION_KEY)
    ? routeOwnerFromScratch(plan.id)
    : { id: plan.id, ownerKey: planAppIdentity(plan).ownerKey };

export const routeOwnerFromGlobalTeardown = (resolved: {
  readonly paths: { readonly root: AbsolutePath };
  readonly evidence:
    | { readonly kind: "applied"; readonly plan: Pick<AppPlan, "id" | "root" | "identity" | "extensions"> }
    | { readonly kind: "orphans" | "owned" | "absent" };
}): AppRouteOwner => {
  const evidence = resolved.evidence;
  switch (evidence.kind) {
    case "applied":
      return routeOwnerFromPlan(evidence.plan);
    case "orphans":
    case "owned":
    case "absent":
      return routeOwnerFromRoot("global", resolved.paths.root);
    default:
      return evidence satisfies never;
  }
};
