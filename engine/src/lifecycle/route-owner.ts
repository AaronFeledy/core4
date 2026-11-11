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
      return { id: AppId.make("global"), ownerKey: appIdentityKey("owner", resolved.paths.root) };
    default:
      return evidence satisfies never;
  }
};
