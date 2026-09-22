/** Local port of Landofile overlay semantics; the plugin DAG excludes @lando/landofile. */
export const ARRAY_IDENTITY_KEYS = ["name", "id", "hostname", "service"] as const;

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const identityKeyFor = (
  item: Record<string, unknown>,
): (typeof ARRAY_IDENTITY_KEYS)[number] | undefined =>
  ARRAY_IDENTITY_KEYS.find((key) => Object.hasOwn(item, key));

export type RouteFilterIdentity =
  | { readonly kind: "name"; readonly value: unknown }
  | { readonly kind: "type"; readonly value: unknown };

export const routeFilterIdentity = (item: unknown): RouteFilterIdentity | undefined => {
  if (!isPlainRecord(item)) return undefined;
  if (Object.hasOwn(item, "name")) return { kind: "name", value: item.name };
  if (Object.hasOwn(item, "type")) return { kind: "type", value: item.type };
  return undefined;
};

export const routeFilterMatches = (candidate: unknown, item: unknown): boolean => {
  const left = routeFilterIdentity(candidate);
  const right = routeFilterIdentity(item);
  return left !== undefined && right !== undefined && left.kind === right.kind && left.value === right.value;
};

const mergeArrays = (
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  arrayKey?: string,
): ReadonlyArray<unknown> => {
  if (!left.every(isPlainRecord) || !right.every(isPlainRecord)) return right;
  if (arrayKey === "filters") {
    if ([...left, ...right].some((item) => routeFilterIdentity(item) === undefined)) return right;
    const merged: Record<string, unknown>[] = left.map((item) => ({ ...item }));
    for (const item of right) {
      const existingIndex = merged.findIndex((candidate) => routeFilterMatches(candidate, item));
      if (existingIndex === -1) {
        merged.push({ ...item });
        continue;
      }
      const existing = merged[existingIndex];
      if (existing !== undefined) {
        const existingType = existing.type;
        const overlayType = item.type;
        merged[existingIndex] =
          typeof existingType === "string" && typeof overlayType === "string" && existingType !== overlayType
            ? { ...item }
            : (mergeValues(existing, item) as Record<string, unknown>);
      }
    }
    return merged;
  }
  const keyed = [...left, ...right].map((item) => ({ item, key: identityKeyFor(item) }));
  if (keyed.some(({ key }) => key === undefined)) return right;
  const merged: Record<string, unknown>[] = left.map((item) => ({ ...item }));
  for (const item of right) {
    const key = identityKeyFor(item);
    if (key === undefined) return right;
    const identity = item[key];
    const existingIndex = merged.findIndex((candidate) => candidate[key] === identity);
    if (existingIndex === -1) {
      merged.push({ ...item });
      continue;
    }
    const existing = merged[existingIndex];
    if (existing !== undefined)
      merged[existingIndex] = mergeValues(existing, item) as Record<string, unknown>;
  }
  return merged;
};

export const mergeValues = (left: unknown, right: unknown, key?: string): unknown => {
  if (Array.isArray(left) && Array.isArray(right)) return mergeArrays(left, right, key);
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;
  const result: Record<string, unknown> = { ...left };
  for (const [childKey, rightValue] of Object.entries(right)) {
    result[childKey] = Object.hasOwn(result, childKey)
      ? mergeValues(result[childKey], rightValue, childKey)
      : rightValue;
  }
  return result;
};

export const mergeLandofiles = <T extends Record<string, unknown>>(files: ReadonlyArray<T>): T =>
  files.reduce<Record<string, unknown>>(
    (merged, file) => mergeValues(merged, file) as Record<string, unknown>,
    {},
  ) as T;
