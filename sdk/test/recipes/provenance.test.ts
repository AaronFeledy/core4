import { expect, test } from "bun:test";
import { Either } from "effect";
import {
  deriveRecipeProducer,
  isBareRecipeReference,
  recipeFamilyKey,
  validateLandofileRecipeProvenance,
} from "../../src/recipes/provenance.ts";

const producer = {
  sourceKind: "bundled",
  packageName: "recipes",
  recipeId: "php",
  manifestVersion: "1.0.0",
  contentDigest: `sha256:${"a".repeat(64)}`,
} as const;
const provenance = { id: "php", version: "1.0.0", producer, options: {} };
test("bundled-vs-local family separation", () => {
  expect(recipeFamilyKey(deriveRecipeProducer(producer))).not.toBe(
    recipeFamilyKey({ ...producer, sourceKind: "local" }),
  );
});
test("bare-string provenance stays valid", () => {
  expect(Either.getOrThrow(validateLandofileRecipeProvenance("php"))).toBe("php");
  expect(isBareRecipeReference("php")).toBe(true);
  expect(isBareRecipeReference(provenance)).toBe(false);
});
test.each([
  ["identity-mismatch", { ...provenance, id: "ruby" }, "producer.recipeId"],
  ["version-mismatch", { ...provenance, version: "2.0.0" }, "producer.manifestVersion"],
  ["service-map-not-injective", { ...provenance, services: { a: "web", b: "web" } }, "services"],
  ["malformed", 42, undefined],
] as const)("provenance reason %s", (reason, value, path) => {
  const result = validateLandofileRecipeProvenance(value);
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left.reason).toBe(reason);
    if (path) expect(result.left.path).toBe(path);
  }
});
