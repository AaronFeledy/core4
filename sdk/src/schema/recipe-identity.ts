import { Schema } from "effect";

// ==== Recipe identity: the coordinates every provenance, snapshot, and migration edge agrees on.

const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});

const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Recipe id — kebab-case identifier; matches directory basename. */
export const RecipeId = Schema.String.pipe(
  Schema.pattern(KEBAB_CASE_PATTERN, {
    message: () => "Recipe id must be lowercase kebab-case (a-z, 0-9, hyphen).",
  }),
);
export type RecipeId = typeof RecipeId.Type;

/** Recipe semver string. */
export const RecipeVersion = Schema.String.pipe(
  Schema.pattern(SEMVER_PATTERN, {
    message: () => "Recipe version must be a semver string (e.g. 1.0.0).",
  }),
);
export type RecipeVersion = typeof RecipeVersion.Type;

/**
 * Where a recipe producer came from. Two producers that agree on package and
 * recipe name but disagree here are different families and never collide.
 */
export const RecipeSourceKind = Schema.Literal("bundled", "plugin", "local").annotations(
  metadata("RecipeSourceKind", "Origin class of the recipe producer."),
);
export type RecipeSourceKind = typeof RecipeSourceKind.Type;

/** Package that publishes the recipe producer. */
export const RecipePackageName = Schema.String.pipe(Schema.minLength(1)).annotations(
  metadata("RecipePackageName", "Package name publishing the recipe producer."),
);
export type RecipePackageName = typeof RecipePackageName.Type;

/**
 * SHA-256 over canonical recipe manifest data. It excludes the digest field
 * itself and all migration history, so a producer can record its own digest
 * without creating a circular definition.
 */
export const RecipeContentDigest = Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/)).annotations(
  metadata("RecipeContentDigest", "SHA-256 over canonical recipe inputs, excluding the digest and history."),
);
export type RecipeContentDigest = typeof RecipeContentDigest.Type;

/**
 * Complete producer identity. `sourceKind + packageName + recipeId` is the
 * family; adding `manifestVersion + contentDigest` yields versioned identity.
 */
export const RecipeProducer = Schema.Struct({
  sourceKind: RecipeSourceKind.annotations({ description: "Origin class of the producing recipe." }),
  packageName: RecipePackageName.annotations({ description: "Package that publishes the recipe." }),
  recipeId: RecipeId.annotations({ description: "Recipe id inside the publishing package." }),
  manifestVersion: RecipeVersion.annotations({
    description: "Recipe manifest version that produced the data.",
  }),
  contentDigest: RecipeContentDigest.annotations({
    description: "Digest of the canonical recipe inputs behind this version.",
  }),
}).annotations(metadata("RecipeProducer", "Versioned identity of the recipe that produced generated data."));
export type RecipeProducer = typeof RecipeProducer.Type;

const OptionScalar = Schema.Union(Schema.String, Schema.Number, Schema.Boolean);

/** Persistable nonsecret recipe option value. Secret answers never appear here. */
export const RecipeOptionValue = Schema.Union(OptionScalar, Schema.Array(OptionScalar)).annotations(
  metadata("RecipeOptionValue", "Nonsecret scalar or scalar-array recipe option value."),
);
export type RecipeOptionValue = typeof RecipeOptionValue.Type;

/**
 * Generated service name to current user-selected service name. The map must be
 * injective so a rename can never merge two generated services into one.
 */
export const RecipeServiceMap = Schema.Record({
  key: Schema.String.pipe(Schema.minLength(1)),
  value: Schema.String.pipe(Schema.minLength(1)),
})
  .pipe(
    Schema.filter((value) => {
      const targets = new Set<string>();
      for (const current of Object.values(value)) {
        if (targets.has(current))
          return `Service map is not injective: two generated names map to "${current}".`;
        targets.add(current);
      }
      return true;
    }),
  )
  .annotations(
    metadata("RecipeServiceMap", "Injective map from generated service name to current service name."),
  );
export type RecipeServiceMap = typeof RecipeServiceMap.Type;

/** Stable family key: producers sharing it are the same recipe lineage. */
export const recipeFamilyKey = (producer: {
  readonly sourceKind: string;
  readonly packageName: string;
  readonly recipeId: string;
}): string => `${producer.sourceKind}:${producer.packageName}:${producer.recipeId}`;

/** Stable versioned key: family plus the exact manifest version and content digest. */
export const recipeVersionedKey = (producer: RecipeProducer): string =>
  `${recipeFamilyKey(producer)}@${producer.manifestVersion}#${producer.contentDigest}`;

/** True when both producers belong to the same recipe family. */
export const sameRecipeFamily = (left: RecipeProducer, right: RecipeProducer): boolean =>
  recipeFamilyKey(left) === recipeFamilyKey(right);

/** True when both producers are the same exact versioned identity. */
export const sameRecipeVersion = (left: RecipeProducer, right: RecipeProducer): boolean =>
  recipeVersionedKey(left) === recipeVersionedKey(right);
