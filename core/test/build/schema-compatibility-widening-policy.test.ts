import { expect, test } from "bun:test";
import { compareArtifactSets } from "../../../scripts/check-schema-compatibility.ts";
import type { JsonSchema, SchemaPolarity } from "../../../scripts/schema-compatibility/model.ts";
import { suggestCompatibilityExceptions } from "../../../scripts/schema-compatibility/suggest-exceptions.ts";

const surface = "schema:Mode";
const store = "applied-state";
const persistedStoresBySurface = new Map([[surface, new Set<typeof store>([store])]]);
const artifact = (polarity: SchemaPolarity, schema: JsonSchema) =>
  new Map([[surface, { surface, polarity, schema }]]);
const before = (polarity: SchemaPolarity) => artifact(polarity, { enum: ["plain"] });
const after = (polarity: SchemaPolarity) => artifact(polarity, { enum: ["plain", "styled"] });

test.each([
  ["output", "breaking"],
  ["strict", "unknown"],
] as const)(
  "requires both a reviewed exception and a store bump for persisted %s widening",
  (polarity, verdict) => {
    const policy = {
      persistedStoresBySurface,
      storeVersions: { [store]: 2 },
      baseStoreVersions: { [store]: 1 },
    };
    const unreviewed = compareArtifactSets(before(polarity), after(polarity), { ...policy, exceptions: [] });
    const [entry] = suggestCompatibilityExceptions(unreviewed, [], policy);
    if (entry === undefined) throw new Error("Expected a review suggestion for the public contract.");
    const review = { ...entry, justification: "Consumers can ignore the new mode." };

    expect(unreviewed).toEqual([expect.objectContaining({ verdict, accepted: false })]);
    expect(entry).toMatchObject({
      changeKind: "enum-widened",
      locations: [{ surface, path: "$" }],
      persistedState: [{ store, version: 2 }],
    });
    const withoutMetadata = compareArtifactSets(before(polarity), after(polarity), {
      ...policy,
      exceptions: [
        {
          fingerprint: review.fingerprint,
          locations: review.locations,
          changeKind: review.changeKind,
          justification: review.justification,
        },
      ],
    });
    const withoutBump = compareArtifactSets(before(polarity), after(polarity), {
      ...policy,
      baseStoreVersions: { [store]: 2 },
      exceptions: [review],
    });
    const reviewed = compareArtifactSets(before(polarity), after(polarity), {
      ...policy,
      exceptions: [review],
    });
    expect(withoutMetadata).toEqual([expect.objectContaining({ verdict, accepted: false })]);
    expect(withoutBump).toEqual([expect.objectContaining({ verdict, accepted: false })]);
    expect(reviewed).toEqual([expect.objectContaining({ verdict, accepted: true })]);
  },
);

test.each([
  ["missing baseline", {}, { [store]: 2 }, true],
  ["missing current version", { [store]: 1 }, {}, false],
] as const)(
  "offers exception review for persisted input widening with %s",
  (_label, baseStoreVersions, storeVersions, accepted) => {
    const policy = { persistedStoresBySurface, baseStoreVersions, storeVersions };
    const unreviewed = compareArtifactSets(before("input"), after("input"), { ...policy, exceptions: [] });
    const [entry] = suggestCompatibilityExceptions(unreviewed, [], policy);
    if (entry === undefined) throw new Error("Expected a suggestion when the version check is inconclusive.");
    const reviewed = compareArtifactSets(before("input"), after("input"), {
      ...policy,
      exceptions: [
        {
          ...entry,
          justification: "Stored values remain readable.",
          persistedState: { store, version: 2 },
        },
      ],
    });

    expect(unreviewed).toEqual([expect.objectContaining({ verdict: "unknown", accepted: false })]);
    expect(entry).toMatchObject({ changeKind: "enum-widened", locations: [{ surface, path: "$" }] });
    expect(entry.persistedState).toEqual(accepted ? [{ store, version: 2 }] : undefined);
    expect(reviewed).toEqual([expect.objectContaining({ verdict: "unknown", accepted })]);
  },
);
