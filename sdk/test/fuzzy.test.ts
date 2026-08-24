import { describe, expect, test } from "bun:test";

import { bestFuzzy, rankFuzzy } from "@lando/sdk/fuzzy";

type Recipe = {
  readonly id: string;
  readonly title: string;
};

const CATALOG: readonly Recipe[] = [
  { id: "wordpress", title: "WordPress" },
  { id: "node-postgres", title: "Node + Postgres" },
  { id: "rails", title: "Ruby on Rails" },
  { id: "django", title: "Django" },
];

const titleOf = (item: Recipe): string => item.title;

const rankIds = (query: string): readonly string[] =>
  rankFuzzy(query, CATALOG, titleOf).map((hit) => hit.item.id);

describe("rankFuzzy", () => {
  test.each([
    { query: "wp", first: "wordpress" },
    { query: "np", first: "node-postgres" },
    { query: "ror", first: "rails" },
  ])("ranks $first first when the query is $query", ({ query, first }) => {
    // Given the recipe catalog
    // When ranking titles against the query
    const ranked = rankIds(query);
    // Then the expected recipe is first
    expect(ranked[0]).toBe(first);
  });

  test("preserves catalog order and includes every item when the query is empty", () => {
    // Given the recipe catalog
    // When ranking with an empty query
    const hits = rankFuzzy("", CATALOG, titleOf);
    // Then every item is returned in original order with score 0
    expect(hits.map((hit) => hit.item.id)).toEqual([
      "wordpress",
      "node-postgres",
      "rails",
      "django",
    ]);
    expect(hits.every((hit) => hit.score === 0)).toBe(true);
  });

  test("yields no hits when the query matches nothing", () => {
    // Given the recipe catalog
    // When ranking against a non-subsequence
    const hits = rankFuzzy("zzzz", CATALOG, titleOf);
    // Then the result is empty
    expect(hits).toEqual([]);
  });
});

describe("bestFuzzy", () => {
  test("returns the top hit when its score meets the threshold", () => {
    // Given the recipe catalog
    // When taking the best match for wp at minScore 1
    const best = bestFuzzy("wp", CATALOG, titleOf, 1);
    // Then WordPress is selected
    expect(best?.id).toBe("wordpress");
  });

  test("returns undefined when the top hit is below the threshold", () => {
    // Given the recipe catalog
    // When taking the best match for wp at an unreachable minScore
    const best = bestFuzzy("wp", CATALOG, titleOf, 99999);
    // Then nothing is selected
    expect(best).toBeUndefined();
  });
});
