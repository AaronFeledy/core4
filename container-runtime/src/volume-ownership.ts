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
 * ownership through {@link planVolumeOwnership}, so the pair cannot drift.
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
import { type AppIdentity, type AppPlan, appIdentityKey } from "@lando/sdk/schema";

import {
  type VolumeFilterMap,
  type VolumeSelectorClass,
  buildLandoVolumeFilters,
  volumeSelectorValue,
} from "./podman/volume-prune.ts";
import { volumeClassForStore } from "./volume-classes.ts";

/** Canonical app root, written verbatim; the ownership proof readers compare against. */
export const VOLUME_OWNER_LABEL = "dev.lando.volume-owner";

/** Ownership-complete selection value; the only label a prune filter may select on. */
export const VOLUME_SELECTOR_LABEL = "dev.lando.volume-selector";

/**
 * The ownership identity behind both labels. A planned plan answers with the
 * identity the planner stamped; a plan that lost it is migrated from its root
 * through the same derivation.
 */
export const planVolumeOwnership = (plan: AppPlan): AppIdentity =>
  plan.identity ?? { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) };

/** The ownership label pair for one store; neither label is ever written without the other. */
export const volumeOwnershipLabels = (
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Readonly<Record<string, string>> => {
  const ownership = planVolumeOwnership(plan);
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
    ownerKey: planVolumeOwnership(plan).ownerKey,
    volumeClasses,
  });
