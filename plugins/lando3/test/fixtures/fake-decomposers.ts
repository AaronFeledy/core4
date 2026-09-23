import { ConfigTranslateDocumentSetInput, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type {
  RecipeDecomposeInput,
  RecipeDecomposeResult,
  RecipeDecomposerFactory,
  RecipeDecomposerPorts,
} from "@lando/sdk/services";
import { Effect, Schema } from "effect";

export const document = (path: string, text: string) => ({
  sourceId: ConfigTranslateSourceId.make(path),
  layerId: "canonical" as const,
  path,
  mediaType: "application/yaml",
  contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`,
  bytes: Buffer.from(text).toString("base64"),
});
export const documentSet = (documents: ReadonlyArray<ReturnType<typeof document>>) =>
  Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
    _tag: "landofile-document-set",
    documents,
    mode: "full",
    selectedSourceIds: documents.map(({ sourceId }) => sourceId),
    currentLowerV4Fragments: [],
    writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
  });

export const fakeDecomposers = (nested = false, withEndpoint = false) => {
  const calls: RecipeDecomposeInput[] = [];
  const receivedPorts: RecipeDecomposerPorts[] = [];
  const results: RecipeDecomposeResult[] = [];
  const methods: string[] = [];
  const decomposers = new Map<string, RecipeDecomposerFactory>();
  for (const recipeId of ["wordpress", "drupal", "lamp"]) {
    decomposers.set(recipeId, (ports) => {
      receivedPorts.push(ports);
      const producer = {
        sourceKind: "bundled" as const,
        packageName: "@lando/test-recipes",
        recipeId,
        manifestVersion: "1.0.0",
        contentDigest: `sha256:${"a".repeat(64)}`,
      };
      return {
        producer,
        decompose: (input) =>
          Effect.sync(() => {
            methods.push("decompose");
            calls.push(input);
            const fragment =
              recipeId === "drupal"
                ? { services: { database: { image: String(input.options.database) } } }
                : nested
                  ? {
                      services: {
                        appserver: {
                          image: "php:8.3",
                          environment: {
                            KEEP: "yes",
                            ...(input.options.redis === true ? { REMOVE: "yes" } : {}),
                          },
                        },
                      },
                    }
                  : {
                      services: {
                        appserver: {
                          image: "php:8.3",
                          ...(withEndpoint
                            ? { endpoints: [{ _tag: "internal", protocol: "http", port: 80 }] }
                            : {}),
                        },
                        ...(input.options.redis === true ? { redis: { image: "redis:7" } } : {}),
                      },
                    };
            const result = {
              fragment,
              provenance: { id: recipeId, version: "1.0.0", producer, options: input.options },
            };
            results.push(result);
            return result;
          }),
      };
    });
  }
  return { decomposers, calls, receivedPorts, results, methods };
};
