/**
 * The one place a Lando volume's ownership identity is written and read.
 *
 * Two labels carry ownership, and they are not interchangeable:
 *
 * - `dev.lando.volume-owner` records the canonical app root verbatim. It is
 *   authoritative for ownership PROOF — the planful volume delete gate in
 *   `@lando/provider-docker`, create-race detection in `volumeCreationFact`,
 *   adoption and witness checks in `volume-observation.ts` /
 *   `native-volume-identity.ts`, and SQL recovery adoption all compare it
 *   against a root they already hold.
 * - `dev.lando.volume-selector` packs provider, app, owner key, and volume
 *   class into ONE value. It is authoritative for SELECTION — bring-down's
 *   local match and the daemon-side prune filter. Ownership has to be complete
 *   inside a single value because the daemon ORs the values listed under one
 *   label key, so splitting ownership across keys would broaden a prune.
 *
 * The invariant: the selector's owner key is derived from the same canonical
 * root the owner label records, `appIdentityKey("owner", appRoot)` — the
 * derivation the planner uses to stamp `AppPlan.identity`. Both labels are
 * emitted together by {@link volumeOwnershipLabels} and every reader resolves
 * ownership through {@link planAppIdentity}, so the pair cannot drift.
 *
 * A plan that carries no `identity` is migrated here, at read time, from
 * `plan.root`: the planner assigns `root` from `identity.appRoot`, so the
 * derived key is byte-identical to the one a planned plan carries, and no
 * selector is ever written in a second format. An identity-less plan is
 * trusted to carry a canonical root, because only the planner canonicalizes.
 *
 * No legacy selector format is accepted. The owner key became part of the
 * selector in the same revision that made the planner stamp every plan with an
 * identity, so no volume can carry a selector built from a raw root; volumes
 * older than that revision carry a three-part selector that never matched
 * either form. The labels are not collapsed into one, so nothing here needs a
 * migration path for volumes an earlier build created.
 */
import { type AppPlan, appIdentityKey, planAppIdentity } from "@lando/sdk/schema";

import { isOwnershipRoot } from "./ownership-root.ts";
import {
  type VolumeFilterMap,
  type VolumeSelectorClass,
  buildLandoVolumeFilters,
  volumeSelectorValue,
} from "./podman/volume-prune.ts";
import { volumeClassForStore } from "./volume-classes.ts";
import { volumeClassFromLabels } from "./volume-classes.ts";

/** Canonical app root, written verbatim; the ownership proof readers compare against. */
export const VOLUME_OWNER_LABEL = "dev.lando.volume-owner";

/** Ownership-complete selection value; the only label a prune filter may select on. */
export const VOLUME_SELECTOR_LABEL = "dev.lando.volume-selector";

export const coherentVolumeOwnership = (
  labels: Readonly<Record<string, string>>,
  providerId: string,
): boolean => {
  const root = labels[VOLUME_OWNER_LABEL];
  const app = labels["dev.lando.app"];
  const scope = labels["dev.lando.scope"];
  const kind = labels["dev.lando.storage-kind"];
  if (
    !root ||
    !isOwnershipRoot(root) ||
    !app ||
    !labels["dev.lando.store"] ||
    !labels["dev.lando.volume-instance"]
  )
    return false;
  if (scope !== "app" && scope !== "service" && scope !== "global") return false;
  if (kind !== undefined && kind !== "cache") return false;
  if (labels["dev.lando.provider"] !== undefined && labels["dev.lando.provider"] !== providerId) return false;
  if (labels["dev.lando.app-root"] !== undefined && labels["dev.lando.app-root"] !== root) return false;
  if (labels["dev.lando.owner"] !== undefined && labels["dev.lando.owner"] !== appIdentityKey("owner", root))
    return false;
  if (labels["com.lando.app"] !== undefined && labels["com.lando.app"] !== app) return false;
  return (
    labels[VOLUME_SELECTOR_LABEL] ===
    volumeSelectorValue({
      providerId,
      appId: app,
      ownerKey: appIdentityKey("owner", root),
      volumeClass: volumeClassFromLabels(labels),
    })
  );
};

/** The ownership label pair for one store; neither label is ever written without the other. */
export const volumeOwnershipLabels = (
  plan: Pick<AppPlan, "id" | "provider" | "root" | "identity">,
  store: AppPlan["stores"][number],
): Readonly<Record<string, string>> => {
  const ownership = planAppIdentity(plan);
  return {
    [VOLUME_OWNER_LABEL]: ownership.appRoot,
    [VOLUME_SELECTOR_LABEL]: volumeSelectorValue({
      providerId: plan.provider,
      appId: plan.id,
      ownerKey: ownership.ownerKey,
      volumeClass: volumeClassForStore(store),
    }),
  };
};

/** The selector filters that read back exactly what {@link volumeOwnershipLabels} wrote. */
export const planVolumeFilters = (
  plan: AppPlan,
  volumeClasses: ReadonlyArray<VolumeSelectorClass>,
): VolumeFilterMap =>
  buildLandoVolumeFilters(plan.id, {
    providerId: plan.provider,
    ownerKey: planAppIdentity(plan).ownerKey,
    volumeClasses,
  });
