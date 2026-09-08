import { Either, ParseResult, Schema } from "effect";
import { RecipeProvenanceError } from "../errors/recipe.ts";
import { RecipeProducer } from "../schema/recipe-identity.ts";
import { LandofileRecipeField } from "../schema/recipe-provenance.ts";

export {
  recipeFamilyKey,
  recipeVersionedKey,
  sameRecipeFamily,
  sameRecipeVersion,
} from "../schema/recipe-identity.ts";

/**
 * Decode inert Landofile recipe data without resolving or executing a recipe.
 * Cross-field failures retain their machine reason and the known dotted path;
 * diagnostics never copy option values out of a schema parse error.
 */
export const validateLandofileRecipeProvenance = (
  value: unknown,
): Either.Either<LandofileRecipeField, RecipeProvenanceError> =>
  Schema.decodeUnknownEither(LandofileRecipeField)(value).pipe(
    Either.mapLeft((error) => {
      const message = error.message;
      let reason: RecipeProvenanceError["reason"];
      let path: string | undefined;
      if (/injectiv/i.test(message)) {
        reason = "service-map-not-injective";
        path = "services";
      } else if (/disagrees with producer\.recipeId/.test(message)) {
        reason = "identity-mismatch";
        path = "producer.recipeId";
      } else if (/disagrees with producer\.manifestVersion/.test(message)) {
        reason = "version-mismatch";
        path = "producer.manifestVersion";
      } else {
        reason = "malformed";
        path = ParseResult.ArrayFormatter.formatErrorSync(error)
          .find((issue) => issue.path.length > 0)
          ?.path.map(String)
          .join(".");
      }
      return new RecipeProvenanceError({
        reason,
        message: `Invalid recipe provenance (${reason}).`,
        remediation:
          "Correct the recipe identity, version, options, and injective service map in the Landofile.",
        ...(path === undefined ? {} : { path }),
      });
    }),
  );

/** Narrow the legacy inert id form without looking up its producer. */
export const isBareRecipeReference = (field: LandofileRecipeField): field is string =>
  typeof field === "string";

/**
 * Construct and validate a producer from its five canonical coordinates.
 * Invalid coordinates throw the schema's parse error; unknown wire input should
 * instead be decoded at its boundary before calling this identity constructor.
 */
export const deriveRecipeProducer = (input: RecipeProducer): RecipeProducer =>
  Schema.decodeUnknownSync(RecipeProducer)(input);
