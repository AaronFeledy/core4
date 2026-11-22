import { type AppPlan, LANDO_DATA_ROOT_LABEL, planDataId } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import { matchesDataRoot } from "../data-root-labels.ts";
import { STORE_LABEL } from "../labels.ts";
import { NativeVolumeSchema } from "../native-volume-identity.ts";
import {
  type SkippedVolume,
  type TeardownVolumeRuntime,
  type VolumeDeletion,
  type VolumeDeletionCandidate,
  matchesSharedCache,
  skippedVolume,
  snapshotVolumeDeletion,
  teardownVolumeFailure,
} from "../teardown-volumes.ts";
import {
  STORAGE_SCOPE_LABEL,
  type TeardownVolumeSelection,
  isGlobalScopedVolume,
  teardownVolumeClasses,
  volumeClassForStore,
  volumeClassFromLabels,
} from "../volume-classes.ts";
import {
  coherentVolumeOwnership,
  isGlobalCacheStore,
  ownedVolumeLockTier,
  planVolumeFilters,
} from "../volume-ownership.ts";
import { volumeMatchesFilters } from "./volume-prune.ts";

const NativeVolumes = Schema.Array(NativeVolumeSchema);
const VolumeList = Schema.fromJsonString(
  Schema.Union([NativeVolumes, Schema.Struct({ Volumes: Schema.NullOr(NativeVolumes) })]),
);

export const planVolumeDeletions = Effect.fnUntraced(function* (
  runtime: TeardownVolumeRuntime,
  plan: AppPlan,
  selection: TeardownVolumeSelection,
) {
  if (!selection.volumes && !selection.purgeCaches) return { candidates: [], skipped: [] };
  const classes = teardownVolumeClasses(selection);
  const appId = planDataId(plan);
  const filters = classes.map((volumeClass) => planVolumeFilters(plan, [volumeClass]));
  const matchesApp = (labels: Readonly<Record<string, string>>) =>
    !isGlobalScopedVolume(labels) &&
    matchesDataRoot(
      labels[LANDO_DATA_ROOT_LABEL],
      plan.identity?.dataRoot,
      plan.stores.some(({ name }) => name === labels[STORE_LABEL]),
    ) &&
    coherentVolumeOwnership(labels, plan.provider) &&
    filters.some((filter) => volumeMatchesFilters(labels, filter));
  const names = new Map<string, VolumeDeletion>();
  for (const store of plan.stores) {
    const volumeClass = volumeClassForStore(store);
    if (!classes.includes(volumeClass)) continue;
    const shared = isGlobalCacheStore(store);
    if (store.scope === "global" && !shared) continue;
    names.set(store.name, {
      appId,
      name: store.name,
      volumeClass,
      shared,
      tier: ownedVolumeLockTier(plan.id, shared),
      matches: (labels) =>
        shared
          ? matchesSharedCache(plan.provider, store.name, labels)
          : matchesApp(labels) &&
            labels[STORE_LABEL] === store.name &&
            labels[STORAGE_SCOPE_LABEL] === store.scope &&
            volumeClassFromLabels(labels) === volumeClass,
    });
  }
  const response = yield* runtime.request({ method: "GET", path: "/volumes" });
  const list = Schema.decodeUnknownOption(VolumeList)(response.body);
  if (response.status !== 200 || Option.isNone(list))
    return yield* teardownVolumeFailure(runtime.ctx, "Could not enumerate app-owned volumes.", response);
  const candidates: VolumeDeletionCandidate[] = [];
  const skipped: SkippedVolume[] = [];
  for (const { Name: name, Labels } of "Volumes" in list.value ? (list.value.Volumes ?? []) : list.value) {
    const labels = Labels ?? {};
    const named = names.get(name);
    if (named === undefined && !matchesApp(labels)) continue;
    const volumeClass = volumeClassFromLabels(labels);
    const volume = named ?? {
      appId,
      name,
      volumeClass,
      shared: false,
      tier: ownedVolumeLockTier(plan.id, false),
      matches: (fresh: Readonly<Record<string, string>>) =>
        matchesApp(fresh) &&
        fresh[STORE_LABEL] === labels[STORE_LABEL] &&
        fresh[STORAGE_SCOPE_LABEL] === labels[STORAGE_SCOPE_LABEL] &&
        volumeClassFromLabels(fresh) === volumeClass,
    };
    const observed = yield* snapshotVolumeDeletion(runtime, volume, labels).pipe(
      Effect.catchIf(
        () => volume.shared,
        () => Effect.succeed({ kind: "unverified" } as const),
      ),
    );
    switch (observed.kind) {
      case "candidate":
        candidates.push(observed.candidate);
        break;
      case "unverified":
        if (volume.shared)
          skipped.push(skippedVolume(volume, "shared cache ownership could not be verified"));
        break;
      case "absent":
        break;
    }
  }
  return { candidates, skipped };
});
