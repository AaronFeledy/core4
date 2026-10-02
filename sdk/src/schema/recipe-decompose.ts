import { Schema } from "effect";

import { ConfigTranslateSecretReference } from "./config-translate.ts";
import { LandofileAuthoringFragmentWire } from "./landofile-authoring.ts";
import { RecipeOptionValue, RecipeProducer, RecipeServiceMap } from "./recipe-identity.ts";
import { LandofileRecipeProvenance } from "./recipe-provenance.ts";

const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});

interface AuthoringFragmentSchema
  extends Schema.Codec<Schema.Schema.Type<typeof LandofileAuthoringFragmentWire>> {}

const authoringFragment = (description: string): AuthoringFragmentSchema =>
  LandofileAuthoringFragmentWire.annotate({ description });

/**
 * Everything a decomposer is allowed to see. Options are already merged and
 * nonsecret; secret answers appear only as an approved store reference or a
 * named init-only sink, never as bytes.
 */
export const RecipeDecomposeInput = Schema.Struct({
  producer: RecipeProducer.annotate({ description: "Versioned identity of the recipe being decomposed." }),
  options: Schema.Record(Schema.String, RecipeOptionValue).annotate({
    description: "Already-merged persistable nonsecret option values.",
  }),
  secrets: Schema.Record(Schema.String, ConfigTranslateSecretReference).annotate({
    description: "Approved secret references or named init-only sinks, keyed by prompt name.",
  }),
  services: Schema.optionalKey(RecipeServiceMap.annotate({
      description: "Generated to current service names, when the caller already renamed services.",
    })),
}).annotate(metadata("RecipeDecomposeInput", "Merged recipe identity and nonsecret options to decompose."));
export type RecipeDecomposeInput = typeof RecipeDecomposeInput.Type;

/**
 * Everything a decomposer may return: the authoring fragment the user will own
 * and the inert provenance that records how it was generated. No files, no
 * actions, no plan.
 */
export const RecipeDecomposeResult = Schema.Struct({
  fragment: authoringFragment("Complete authoring wire fragment the recipe selected."),
  provenance: LandofileRecipeProvenance.annotate({
    description: "Inert provenance recorded alongside the generated authoring data.",
  }),
}).annotate(metadata("RecipeDecomposeResult", "Authoring fragment and provenance produced by one decomposition."));
export type RecipeDecomposeResult = typeof RecipeDecomposeResult.Type;
