/** Closest allowed key within Damerau-Levenshtein distance 2, or undefined. */
export const suggestionForUnknownKey = (
  unknownKey: string,
  allowedKeys: readonly string[],
): string | undefined => {
  let best: { readonly key: string; readonly distance: number } | undefined;
  for (const key of allowedKeys) {
    if (key === unknownKey) continue;
    const distance = damerauLevenshtein(unknownKey, key);
    if (distance > 2) continue;
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && key.localeCompare(best.key) < 0)
    ) {
      best = { key, distance };
    }
  }
  return best === undefined ? undefined : `Did you mean "${best.key}"?`;
};

const damerauLevenshtein = (left: string, right: string): number => {
  const height = left.length + 1;
  const width = right.length + 1;
  const matrix = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  for (let row = 0; row < height; row += 1) {
    const line = matrix[row];
    if (line !== undefined) line[0] = row;
  }
  const header = matrix[0];
  if (header !== undefined) {
    for (let column = 0; column < width; column += 1) header[column] = column;
  }
  for (let row = 1; row < height; row += 1) {
    for (let column = 1; column < width; column += 1) {
      const current = matrix[row];
      const previous = matrix[row - 1];
      if (current === undefined || previous === undefined) continue;
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const deletion = (previous[column] ?? column) + 1;
      const insertion = (current[column - 1] ?? row) + 1;
      const substitution = (previous[column - 1] ?? 0) + cost;
      let best = Math.min(deletion, insertion, substitution);
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        const transposed = matrix[row - 2]?.[column - 2];
        if (transposed !== undefined) best = Math.min(best, transposed + 1);
      }
      current[column] = best;
    }
  }
  return matrix[left.length]?.[right.length] ?? Math.max(left.length, right.length);
};
