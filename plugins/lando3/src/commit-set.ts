import type { ConfigTranslateDocumentSetInput, ConfigTranslateOutput } from "@lando/sdk/schema";
import { lando3TargetLayer } from "./contract.ts";
import { isAppRootLando3Layer, sourceLayerForDocument } from "./detect.ts";
import { v4LayerRank } from "./v4-merge.ts";

export const completeLando3CommitSet = (
  input: ConfigTranslateDocumentSetInput,
  planned: readonly ConfigTranslateOutput[],
) => {
  // Completion must not turn a cleared translation into writes or deletions.
  if (planned.length === 0) return { outputs: [], deletions: [] };

  const selected = input.documents.filter(
    (document) =>
      isAppRootLando3Layer(document) &&
      (input.mode === "full" || input.selectedSourceIds.includes(document.sourceId)),
  );
  const outputs = [...planned];
  for (const document of selected) {
    const sourceLayer = sourceLayerForDocument(document);
    const targetLayer = lando3TargetLayer(sourceLayer);
    // Empty deltas still replace legacy bytes; the recipe file is removed instead.
    if (sourceLayer !== "recipe" && !outputs.some((output) => output.targetLayer === targetLayer)) {
      outputs.push({ targetLayer, fragment: {}, sourceIds: [document.sourceId] });
    }
  }
  return {
    outputs: outputs.sort((a, b) => v4LayerRank(a.targetLayer) - v4LayerRank(b.targetLayer)),
    deletions: selected
      .filter((document) => sourceLayerForDocument(document) === "recipe")
      .map(({ sourceId }) => ({
        sourceId,
        reason: "Folded into .lando.dist.yml; the legacy recipe layer is no longer loaded.",
      })),
  };
};
