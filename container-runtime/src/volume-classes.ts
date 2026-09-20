import type { LabelMap } from "@lando/sdk/schema";

import type { VolumeSelectorClass } from "./podman/volume-prune.ts";

/** Written by `volumeCreationLabels` for cache stores only, so its absence means a data volume. */
export const STORAGE_KIND_LABEL = "dev.lando.storage-kind";

/** Written by `volumeCreationLabels` from `store.scope` for every Lando-created volume. */
export const STORAGE_SCOPE_LABEL = "dev.lando.scope";

/**
 * The class a volume was created under, read from the labels the creating provider wrote. Teardown
 * that has no plan left reads this where planful bring-down reads `store.kind`.
 */
export const volumeClassFromLabels = (labels: LabelMap | undefined): VolumeSelectorClass =>
  labels?.[STORAGE_KIND_LABEL] === "cache" ? "cache" : "data";

/** Global-scoped volumes outlive any one app root, so app teardown never removes them. */
export const isGlobalScopedVolume = (labels: LabelMap | undefined): boolean =>
  labels?.[STORAGE_SCOPE_LABEL] === "global";

export interface TeardownVolumeSelection {
  readonly volumes?: boolean;
  readonly purgeCaches?: boolean;
}

/** The volume classes a teardown request covers; the one table both planful and orphan paths read. */
export const teardownVolumeClasses = (
  selection: TeardownVolumeSelection,
): ReadonlyArray<VolumeSelectorClass> => {
  if (selection.volumes === true && selection.purgeCaches === true) return ["cache", "data"];
  return selection.purgeCaches === true ? ["cache"] : ["data"];
};
