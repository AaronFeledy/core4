import type { ConfigTranslateSourceId, LandofileLayer } from "@lando/sdk/schema";

import { lando3SourceLayerOrder, lando3TargetLayer } from "./contract.ts";
import type { Lando3Source, Lando3SourceLayer, MergedLegacyValue } from "./contract.ts";
import { mergeLegacySources, mergedToPlain } from "./legacy-merge.ts";

export interface LegacyPrefixView {
  /** Highest Lando 3 layer included in this prefix. */
  readonly layer: Lando3SourceLayer;
  /** Lando 4 destination for this view (`recipe` folds to `dist`). */
  readonly targetLayer: LandofileLayer;
  /** Every source folded into this prefix, in Lando 3 layer order. */
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  /** Foreign-merged value of every layer with order <= this layer. */
  readonly merged: MergedLegacyValue | undefined;
  readonly recipe: MergedLegacyValue | undefined;
  readonly config: MergedLegacyValue | undefined;
}

/** One view per present Lando 3 layer, ascending. */
export const legacyPrefixViews = (sources: ReadonlyArray<Lando3Source>): ReadonlyArray<LegacyPrefixView> => {
  const sorted = [...sources].sort(
    (a, b) => lando3SourceLayerOrder(a.layer) - lando3SourceLayerOrder(b.layer),
  );
  return [...new Set(sorted.map(({ layer }) => layer))].map((layer) => {
    const prefix = sorted.filter(
      (source) => lando3SourceLayerOrder(source.layer) <= lando3SourceLayerOrder(layer),
    );
    const merged = mergeLegacySources(prefix);
    return {
      layer,
      targetLayer: lando3TargetLayer(layer),
      sourceIds: prefix.map(({ sourceId }) => sourceId),
      merged,
      recipe: merged?.kind === "mapping" ? merged.entries.get("recipe") : undefined,
      config: merged?.kind === "mapping" ? merged.entries.get("config") : undefined,
    };
  });
};

/** Keep the highest legacy prefix for each target, in Lando 4 layer order. */
export const foldToTargetLayers = (
  views: ReadonlyArray<LegacyPrefixView>,
): ReadonlyArray<LegacyPrefixView> => {
  const targets = new Map<LandofileLayer, LegacyPrefixView>();
  for (const view of views) {
    const previous = targets.get(view.targetLayer);
    if (
      previous === undefined ||
      lando3SourceLayerOrder(view.layer) > lando3SourceLayerOrder(previous.layer)
    ) {
      targets.set(view.targetLayer, view);
    }
  }
  return [...targets.values()].sort(
    (a, b) => lando3SourceLayerOrder(a.targetLayer) - lando3SourceLayerOrder(b.targetLayer),
  );
};

// Tagged plain projections contain authored spans, not option semantics. Drop all
// span properties recursively and sort keys so provenance/key order cannot add a view.
const stableKey = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((child: unknown) => stableKey(child));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "span")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stableKey(child)]),
    );
  }
  return value;
};

/** Distinct effective options after the first prefix carrying a recipe. */
export const requiredOptionViews = (
  folded: ReadonlyArray<LegacyPrefixView>,
): ReadonlyArray<LegacyPrefixView> => {
  const required: LegacyPrefixView[] = [];
  let previousKey: string | undefined;
  for (const view of folded) {
    if (required.length === 0 && view.recipe === undefined) continue;
    const key = JSON.stringify(stableKey([mergedToPlain(view.recipe), mergedToPlain(view.config)]));
    if (key !== previousKey) {
      required.push(view);
      previousKey = key;
    }
  }
  return required;
};
