import type {
  RecipeConfigLayer,
  RecipeContentDigest,
  RecipeFile,
  RecipePostInitAction,
  RecipeSource,
} from "@lando/sdk/schema";
import type { RecipeDeclaration } from "./manifest/origins";

export type RecipeTransportEvidence =
  | { readonly kind: "git"; readonly commit: string }
  | { readonly kind: "archive"; readonly digest: string };

export interface RecipeSourceEvidence {
  readonly contentDigest: RecipeContentDigest;
  readonly rawDigest?: RecipeContentDigest;
  readonly transport?: RecipeTransportEvidence;
}

export interface ResolvedRecipeDeclaration<Value> extends RecipeDeclaration<Value> {
  readonly evidence: RecipeSourceEvidence;
  readonly evaluation: "declarative" | "typescript";
}

export type ResolvedAuthoredSource = ResolvedRecipeDeclaration<RecipeSource>;

export interface ResolvedRecipeSource {
  readonly sources: readonly ResolvedAuthoredSource[];
  readonly source: RecipeSource;
  readonly files: readonly ResolvedRecipeDeclaration<RecipeFile>[];
  readonly postInit: readonly ResolvedRecipeDeclaration<RecipePostInitAction>[];
  readonly configLayers: readonly RecipeConfigLayer[];
  /** All sources are declarative; not evidence of published versions or migration edges. */
  readonly historyEligible: boolean;
}
