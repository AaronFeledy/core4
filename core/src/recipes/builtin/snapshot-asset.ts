import type { RecipeContentDigest } from "@lando/sdk/schema";

/**
 * Hash one auxiliary asset's stable source bytes for a snapshot inventory.
 *
 * A snapshot is version-level data, so the digest covers the unrendered source
 * a recipe ships, never the bytes a particular init run produced. Templated
 * assets therefore hash with their substitution tokens still in place, which
 * keeps the published digest independent of the app name.
 */
export const recipeAssetDigest = (source: string): RecipeContentDigest =>
  `sha256:${new Bun.CryptoHasher("sha256").update(source, "utf8").digest("hex")}` as RecipeContentDigest;
