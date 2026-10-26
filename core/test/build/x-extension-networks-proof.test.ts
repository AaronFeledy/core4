import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import delta from "./fixtures/x-extension-networks.delta.json";
import { evolveHistoricalNetworks } from "./x-extension-networks-proof.ts";
import { tightenWireString, wireObject } from "./x-extension-wire-proof.ts";

test("pins the reviewed networks delta independently of live schemas", () => {
  // Given the independently captured before/after projections.
  // When their complete contents are hashed without consulting live schemas.
  const digest = createHash("sha256").update(JSON.stringify(delta)).digest("hex");
  // Then changing either projection or its source provenance requires review.
  expect(digest).toBe("fdf44371193c639e6cc808acc58d0504e6ebc13cebd0966bff572bb2f97aa0c3");
});

for (const [label, projection] of [
  ["bare", "bare"],
  ["authoring", "authoring"],
  ["wireAttachment", "authoring"],
] as const) {
  const { before, after } = delta[label];

  test(`replays the standalone ${label} network schema`, () => {
    // Given the complete historical network projection, not a surrounding Landofile.
    const input = structuredClone(before);
    // When the reviewed change is replayed.
    const evolved = evolveHistoricalNetworks(input, projection);
    // Then the full projection changes without mutating the capture.
    expect(evolved).toEqual(after);
    expect(input).toEqual(before);
  });

  test(`replays embedded ${label} networks without changing siblings or union alternatives`, () => {
    // Given a network map behind record and union boundaries.
    const input = {
      anyOf: [
        {
          type: "object",
          additionalProperties: { properties: { networks: before, image: { type: "string" } } },
        },
        { const: "sentinel" },
      ],
    };
    const expected = normalizeJsonSchema({
      anyOf: [
        {
          type: "object",
          additionalProperties: { properties: { networks: after, image: { type: "string" } } },
        },
        { const: "sentinel" },
      ],
    });
    // When replay traverses the containing graph.
    const evolved = evolveHistoricalNetworks(input, projection);
    // Then only the independently pinned network node changes.
    expect(evolved).toEqual(expected);
    expect(input.anyOf[0]?.additionalProperties?.properties.networks).toEqual(before);
  });

  test(`preserves an unreviewed constraint inside the historical ${label} network schema`, () => {
    // Given a historical nested string constraint outside the reviewed delta.
    const changed = normalizeJsonSchema(wireObject(tightenWireString(before)));
    // When replay tries to match the whole historical projection.
    const evolved = evolveHistoricalNetworks(changed, projection);
    // Then it cannot erase that constraint or claim current-subtree equality.
    expect(evolved).toEqual(changed);
    expect(jsonEquals(evolved, after)).toBe(false);
  });

  test(`preserves an extra historical ${label} network constraint`, () => {
    // Given an extra constraint beside the approved union.
    const changed = { ...before, maxProperties: 1 };
    // When the reviewed delta is replayed.
    const evolved = evolveHistoricalNetworks(changed, projection);
    // Then exact-match replacement refuses to erase the extra keyword.
    expect(evolved).toEqual(normalizeJsonSchema(changed));
    expect(jsonEquals(evolved, after)).toBe(false);
  });

  test(`rejects a current ${label} network mutation after positive whole-subtree equality`, () => {
    // Given a successful whole-subtree comparison with the pinned current projection.
    const expected = evolveHistoricalNetworks(before, projection);
    expect(jsonEquals(expected, after)).toBe(true);
    // When an unrelated nested string constraint changes in the current projection.
    const mutated = normalizeJsonSchema(wireObject(tightenWireString(after)));
    // Then the comparison still detects the unapproved change.
    expect(jsonEquals(expected, mutated)).toBe(false);
  });
}
