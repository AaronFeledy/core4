import { describe, expect, test } from "bun:test";

import { LANDOFILE_LAYER_ORDER, landofileLayerRank } from "@lando/sdk/landofile";

describe("landofile layer order", () => {
  test("ranks the default layers from base through user", () => {
    // Given / When
    const ranks = LANDOFILE_LAYER_ORDER.map((layer) => landofileLayerRank(layer));

    // Then
    expect([...LANDOFILE_LAYER_ORDER]).toEqual(["base", "dist", "upstream", "canonical", "local", "user"]);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("ranks an unknown layer after every known layer", () => {
    // Given: the rank helper still fail-closes if a caller widens past the layer union.
    const rank = landofileLayerRank as (layer: string) => number;

    // When / Then
    expect(rank("plugin")).toBe(LANDOFILE_LAYER_ORDER.length);
  });
});
