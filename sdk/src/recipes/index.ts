/** Pure recipe identity, snapshot, migration, option, and secret contract logic. */
import { Either } from "effect";
import type { RecipeSourceKind } from "../schema/recipe-identity.ts";
import type { RecipeManifest } from "../schema/recipe.ts";
import { validateMigrationChain } from "./migration-chain.ts";
import { recipeMigratability } from "./option-types.ts";

export * from "./content-digest.ts";
export * from "./provenance.ts";
export * from "./snapshot-template.ts";
export * from "./migration-chain.ts";
export * from "./option-types.ts";
export * from "./secret-disposition.ts";

/**
 * Extend snapshot migratability with full declarative migration-chain validation.
 * Invalid histories expose their specific chain reason and tagged error; recipes
 * without migration history can still be migratable at their initial snapshot.
 */
export const fullRecipeMigratability = (manifest: RecipeManifest, sourceKind: RecipeSourceKind) => {
  const result = recipeMigratability(manifest, sourceKind);
  if (result.status === "nonmigratable" || manifest.snapshot === undefined) return result;
  const chain = validateMigrationChain(manifest.snapshot.identity, manifest.migrations ?? []);
  return Either.isLeft(chain)
    ? { status: "nonmigratable" as const, reason: chain.left.reason, error: chain.left }
    : result;
};
