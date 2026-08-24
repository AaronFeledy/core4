/**
 * `@lando/sdk/fuzzy` — Effect-free subsequence ranking.
 *
 * Shared by the init recipe picker so filter order is one deterministic
 * score, not a per-surface heuristic.
 *
 * This subpath is the same contracts-only tier as `@lando/sdk/expressions`,
 * `@lando/sdk/probe`, and `@lando/sdk/secrets`: it constructs no
 * `LandoRuntime`, pulls no service `Layer`, and imports nothing. It is
 * **not** a `Context.Tag` service, **not** a schema export, and **not** a
 * pluggable abstraction.
 */

export type FuzzyHit<T> = {
  readonly item: T;
  readonly score: number;
};

const RUN_BONUS = 4;
const START_BONUS = 8;
const WORD_BONUS = 6;

const scoreSubsequence = (query: string, haystack: string): number | undefined => {
  const needle = query.toLowerCase();
  const hay = haystack.toLowerCase();

  let cursor = 0;
  let score = 0;
  let previous = -2;
  let first = -1;

  for (const char of needle) {
    const found = hay.indexOf(char, cursor);
    if (found === -1) {
      return undefined;
    }
    if (first === -1) {
      first = found;
    }
    score += 1;
    if (found === previous + 1) {
      score += RUN_BONUS;
    }
    if (found === 0) {
      score += START_BONUS;
    } else {
      const before = hay[found - 1];
      if (before === " ") {
        score += WORD_BONUS;
      }
    }
    previous = found;
    cursor = found + 1;
  }

  return score - first;
};

export const rankFuzzy = <T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): readonly FuzzyHit<T>[] => {
  if (query.trim() === "") {
    return items.map((item) => ({ item, score: 0 }));
  }

  const hits: FuzzyHit<T>[] = [];
  for (const item of items) {
    const score = scoreSubsequence(query, text(item));
    if (score === undefined) {
      continue;
    }
    hits.push({ item, score });
  }
  hits.sort((left, right) => right.score - left.score);
  return hits;
};

export const bestFuzzy = <T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  minScore: number,
): T | undefined => {
  const [top] = rankFuzzy(query, items, text);
  if (top === undefined || top.score < minScore) {
    return undefined;
  }
  return top.item;
};
