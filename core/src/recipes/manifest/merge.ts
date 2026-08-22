const SCALAR_KEYS = [
  "id",
  "title",
  "description",
  "version",
  "tags",
  "authors",
  "requires",
  "runs",
  "fetchAllowlist",
  "deprecated",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asRecords = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const stripDrop = (item: Record<string, unknown>): Record<string, unknown> => {
  const { drop: _drop, ...rest } = item;
  return rest;
};

const mergeByKey = (
  parent: ReadonlyArray<Record<string, unknown>>,
  child: ReadonlyArray<Record<string, unknown>>,
  key: string,
): ReadonlyArray<Record<string, unknown>> => {
  const result = parent.map(stripDrop);
  const indexByKey = new Map<string, number>();
  for (const [index, item] of result.entries()) {
    const id = item[key];
    if (typeof id === "string") indexByKey.set(id, index);
  }
  for (const item of child) {
    const id = item[key];
    if (typeof id !== "string") continue;
    if (item.drop === true) {
      const index = indexByKey.get(id);
      if (index === undefined) continue;
      result.splice(index, 1);
      indexByKey.delete(id);
      for (const [existing, existingIndex] of indexByKey) {
        if (existingIndex > index) indexByKey.set(existing, existingIndex - 1);
      }
      continue;
    }
    const stripped = stripDrop(item);
    const index = indexByKey.get(id);
    if (index === undefined) {
      indexByKey.set(id, result.length);
      result.push(stripped);
    } else {
      result[index] = stripped;
    }
  }
  return result;
};

/** Strip authoring-only `extends` and `drop` while preserving every other key. */
export const stripExtendsAndDrop = (raw: Record<string, unknown>): Record<string, unknown> => {
  const { extends: _extends, ...rest } = raw;
  const stripList = (value: unknown): unknown =>
    Array.isArray(value) ? value.map((item) => (isRecord(item) ? stripDrop(item) : item)) : value;
  return {
    ...rest,
    ...(Object.hasOwn(rest, "prompts") ? { prompts: stripList(rest.prompts) } : {}),
    ...(Object.hasOwn(rest, "files") ? { files: stripList(rest.files) } : {}),
    ...(Object.hasOwn(rest, "postInit") ? { postInit: stripList(rest.postInit) } : {}),
  };
};

/** Pure parent-then-child recipe merge. Child scalars win with no parent fallback. */
export const mergeRecipeManifests = (
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (Object.hasOwn(child, key)) merged[key] = child[key];
  }
  const prompts = mergeByKey(asRecords(parent.prompts), asRecords(child.prompts), "name");
  const files = mergeByKey(asRecords(parent.files), asRecords(child.files), "dest");
  const postInit = [...asRecords(parent.postInit), ...asRecords(child.postInit)].map(stripDrop);
  if (prompts.length > 0) merged.prompts = prompts;
  if (files.length > 0) merged.files = files;
  if (postInit.length > 0) merged.postInit = postInit;
  return merged;
};
