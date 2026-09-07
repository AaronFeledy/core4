import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Either } from "effect";
import { compare } from "semver";
import { RecipeMigrationChainError } from "../errors/recipe.ts";
import {
  type RecipeProducer,
  recipeFamilyKey,
  recipeVersionedKey,
  sameRecipeFamily,
  sameRecipeVersion,
} from "../schema/recipe-identity.ts";
import {
  type RecipeHunkClassification,
  type RecipeHunkKind,
  type RecipeMigration,
  type RecipeMigrationHunk,
  hasCallableApply,
} from "../schema/recipe-snapshot.ts";

/**
 * Serialize acyclic JSON data with lexically sorted object keys and ordered arrays.
 * Undefined object properties are omitted, while absent array/root values become
 * null, matching JSON's array convention. Non-JSON inputs may throw TypeError.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

/** Derive a stable, layer-sensitive hunk id from exact edge coordinates and path. */
export const deriveHunkId = (input: {
  readonly producer: RecipeProducer;
  readonly from: RecipeProducer;
  readonly to: RecipeProducer;
  readonly layer: string;
  readonly kind: RecipeHunkKind;
  readonly path: string;
}): string =>
  `hunk-${createHash("sha256")
    .update(
      canonicalJson([
        recipeFamilyKey(input.producer),
        input.from.manifestVersion,
        input.from.contentDigest,
        input.to.manifestVersion,
        input.to.contentDigest,
        input.layer,
        input.kind,
        input.path,
      ]),
    )
    .digest("hex")
    .slice(0, 24)}`;

/**
 * Validate declarative history in deterministic reason precedence and return a
 * sorted copy. Exact identities include content digests. Empty history is valid.
 * A shared endpoint joins adjacent edges; revisiting an earlier vertex is a cycle
 * (strictly increasing semver normally rejects such a cycle as reverse first).
 * Raw inputs preserve callable apply detection before schema decoding strips it.
 */
export const validateMigrationChain = (
  target: RecipeProducer,
  migrations: ReadonlyArray<RecipeMigration>,
  raw?: ReadonlyArray<unknown>,
): Either.Either<ReadonlyArray<RecipeMigration>, RecipeMigrationChainError> => {
  const fail = (reason: RecipeMigrationChainError["reason"], edge?: RecipeMigration) =>
    Either.left(
      new RecipeMigrationChainError({
        reason,
        family: recipeFamilyKey(target),
        message: `Invalid recipe migration chain (${reason}).`,
        remediation:
          "Publish a contiguous, increasing history with matching identities, snapshots, and unique derived hunk ids.",
        ...(edge === undefined
          ? {}
          : { from: recipeVersionedKey(edge.from), to: recipeVersionedKey(edge.to) }),
      }),
    );
  if ((raw ?? migrations).some(hasCallableApply)) return fail("callable-apply");
  for (const edge of migrations)
    if (!sameRecipeFamily(edge.from, target) || !sameRecipeFamily(edge.to, target))
      return fail("family-mismatch", edge);
  for (const edge of migrations)
    if (compare(edge.from.manifestVersion, edge.to.manifestVersion) >= 0) return fail("reverse", edge);
  const pairs = new Set<string>();
  for (const edge of migrations) {
    const pair = canonicalJson([recipeVersionedKey(edge.from), recipeVersionedKey(edge.to)]);
    if (pairs.has(pair)) return fail("duplicate", edge);
    pairs.add(pair);
  }
  const starts = new Set<string>();
  for (const edge of migrations) {
    const key = recipeVersionedKey(edge.from);
    if (starts.has(key)) return fail("fork", edge);
    starts.add(key);
  }
  const ends = new Set<string>();
  for (const edge of migrations) {
    const key = recipeVersionedKey(edge.to);
    if (ends.has(key)) return fail("overlap", edge);
    ends.add(key);
  }
  const sorted = [...migrations].sort((a, b) => compare(a.from.manifestVersion, b.from.manifestVersion));
  for (const [index, edge] of sorted.entries()) {
    if (!sameRecipeVersion(edge.to, sorted[index + 1]?.from ?? target)) return fail("gap", edge);
  }
  const visited = new Set<string>();
  for (const edge of sorted) {
    visited.add(recipeVersionedKey(edge.from));
    if (visited.has(recipeVersionedKey(edge.to))) return fail("cycle", edge);
  }
  for (const edge of sorted)
    if (
      !sameRecipeVersion(edge.fromSnapshot.identity, edge.from) ||
      !sameRecipeVersion(edge.toSnapshot.identity, edge.to)
    )
      return fail("snapshot-mismatch", edge);
  for (const [index, edge] of sorted.entries()) {
    const next = sorted[index + 1];
    if (next !== undefined && !isDeepStrictEqual(edge.toSnapshot, next.fromSnapshot))
      return fail("identity-drift", edge);
  }
  for (const edge of sorted)
    for (const hunk of edge.hunks) {
      if (
        hunk.id !==
        deriveHunkId({
          producer: target,
          from: edge.from,
          to: edge.to,
          layer: hunk.layer,
          kind: hunk.kind,
          path: hunk.path,
        })
      )
        return fail("hunk-id-mismatch", edge);
    }
  for (const edge of sorted) {
    const ids = new Set<string>();
    for (const hunk of edge.hunks) {
      if (ids.has(hunk.id)) return fail("hunk-id-collision", edge);
      ids.add(hunk.id);
    }
  }
  return Either.right(sorted);
};

/**
 * Select a suffix of an already validated chain by exact recorded identity.
 * Missing historical snapshots and foreign families never authorize mutation.
 */
export const selectMigrationPath = (
  chain: ReadonlyArray<RecipeMigration>,
  recorded: RecipeProducer | undefined,
  target: RecipeProducer,
):
  | { readonly kind: "path"; readonly migrations: ReadonlyArray<RecipeMigration> }
  | {
      readonly kind: "no-mutation";
      readonly reason: "missing-old-snapshot" | "identity-mismatch" | "already-current";
    } => {
  if (recorded === undefined) return { kind: "no-mutation", reason: "missing-old-snapshot" };
  if (!sameRecipeFamily(recorded, target)) return { kind: "no-mutation", reason: "identity-mismatch" };
  if (sameRecipeVersion(recorded, target)) return { kind: "no-mutation", reason: "already-current" };
  const index = chain.findIndex((edge) => sameRecipeVersion(edge.from, recorded));
  return index === -1
    ? { kind: "no-mutation", reason: "missing-old-snapshot" }
    : { kind: "path", migrations: chain.slice(index) };
};

/**
 * Classify a hunk against its current authoring value without mutating that value.
 * Undefined denotes an absent site. The after-state wins when both states match;
 * customized option defaults are retained, while structural conflicts block.
 */
export const classifyHunk = (
  hunk: RecipeMigrationHunk,
  site: { readonly current: unknown },
): RecipeHunkClassification => {
  switch (hunk.kind) {
    case "add":
      return isDeepStrictEqual(site.current, hunk.new)
        ? "already-satisfied"
        : site.current === undefined
          ? "selected"
          : "blocking";
    case "remove":
      return site.current === undefined
        ? "already-satisfied"
        : isDeepStrictEqual(site.current, hunk.old)
          ? "selected"
          : "blocking";
    case "rename":
    case "replace":
    case "option-default":
      return isDeepStrictEqual(site.current, hunk.new)
        ? "already-satisfied"
        : isDeepStrictEqual(site.current, hunk.old)
          ? "selected"
          : hunk.kind === "option-default"
            ? "retained-option"
            : "blocking";
    default:
      return hunk satisfies never;
  }
};
