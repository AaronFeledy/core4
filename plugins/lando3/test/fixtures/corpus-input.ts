import { basename, join } from "node:path";
import type { ConfigTranslateDocumentSetInput } from "@lando/sdk/schema";
import { lando3SourceLayerOrder, lando3TargetLayer } from "../../src/contract.ts";
import { sourceLayerForDocument } from "../../src/detect.ts";
import manifest from "./corpus/manifest.json";
import { document, documentSet } from "./fake-decomposers.ts";

export const corpusRoot = join(import.meta.dir, "corpus");
export const corpusSets = manifest.documentSets;

export const readCorpusInput = async (
  set: (typeof corpusSets)[number],
): Promise<typeof ConfigTranslateDocumentSetInput.Type> => {
  const documents = await Promise.all(
    set.files.map(async (path) => {
      const text = await Bun.file(join(corpusRoot, path)).text();
      return { ...document(path, text), path: basename(path) };
    }),
  );
  const input = documentSet(documents);
  return {
    ...input,
    documents: input.documents
      .map((entry) => ({
        ...entry,
        layerId: lando3TargetLayer(sourceLayerForDocument(entry)),
      }))
      .sort(
        (left, right) =>
          lando3SourceLayerOrder(sourceLayerForDocument(left)) -
          lando3SourceLayerOrder(sourceLayerForDocument(right)),
      ),
  };
};
