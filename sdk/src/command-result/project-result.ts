import { JsonProjectionError } from "../errors/command.ts";

export const JSON_PROJECTION_REASONS = {
  unknown_key: "unknown_key",
  duplicate_key: "duplicate_key",
  non_object_result: "non_object_result",
} as const;

export type JsonProjectionReason = (typeof JSON_PROJECTION_REASONS)[keyof typeof JSON_PROJECTION_REASONS];

const PATH_SEPARATOR = ".";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const schemaFields = (schema: unknown): Record<string, unknown> | undefined => {
  if (schema === null || (typeof schema !== "object" && typeof schema !== "function")) {
    return undefined;
  }
  if (!("fields" in schema)) return undefined;
  const fields = schema.fields;
  if (!isPlainObject(fields)) return undefined;
  return fields;
};

const throwJsonProjectionError = (fields: {
  readonly message: string;
  readonly keys: readonly string[];
  readonly available: readonly string[];
  readonly reason: JsonProjectionReason;
  readonly remediation: string;
}): never => {
  throw new JsonProjectionError({
    message: fields.message,
    keys: [...fields.keys],
    available: [...fields.available],
    reason: fields.reason,
    remediation: fields.remediation,
  });
};

const requirePlainObject = (encoded: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (isPlainObject(encoded)) return encoded;
  return throwJsonProjectionError({
    message: "Command result is not an object.",
    keys,
    available: [],
    reason: JSON_PROJECTION_REASONS.non_object_result,
    remediation: "Omit result keys or use a command whose result is an object.",
  });
};

const splitProjectionKey = (key: string): readonly string[] => key.split(PATH_SEPARATOR);

const throwUnknownKey = (keys: readonly string[], requested: string, available: readonly string[]): never =>
  throwJsonProjectionError({
    message: `Unknown projection key "${requested}". Available keys: ${available.join(", ")}.`,
    keys,
    available,
    reason: JSON_PROJECTION_REASONS.unknown_key,
    remediation: "Pass a key from the command result.",
  });

const throwDuplicateKey = (keys: readonly string[], available: readonly string[]): never =>
  throwJsonProjectionError({
    message: "Duplicate projection key.",
    keys,
    available,
    reason: JSON_PROJECTION_REASONS.duplicate_key,
    remediation: "Pass each result key once.",
  });

const resolvePath = (record: Record<string, unknown>, key: string, keys: readonly string[]): unknown => {
  let current: unknown = record;
  for (const segment of splitProjectionKey(key)) {
    if (!isPlainObject(current)) {
      return throwJsonProjectionError({
        message: `Cannot project "${key}": intermediate value is not an object.`,
        keys,
        available: [],
        reason: JSON_PROJECTION_REASONS.non_object_result,
        remediation: "Omit result keys or use a command whose result is an object.",
      });
    }
    if (!Object.hasOwn(current, segment)) {
      return throwUnknownKey(keys, key, Object.keys(current));
    }
    current = current[segment];
  }
  return current;
};

const assignPath = (target: Record<string, unknown>, segments: readonly string[], value: unknown): void => {
  let current = target;
  const leaf = segments.at(-1);
  if (leaf === undefined) return;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (isPlainObject(existing)) {
      current = existing;
      continue;
    }
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  current[leaf] = value;
};

export const listSelectableResultKeys = (schema: unknown): readonly string[] => {
  const fields = schemaFields(schema);
  return fields === undefined ? [] : Object.keys(fields);
};

export const projectEncodedResult = (encoded: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = requirePlainObject(encoded, keys);
  const available = Object.keys(record);
  const seen = new Set<string>();
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (seen.has(key)) return throwDuplicateKey(keys, available);
    seen.add(key);
    assignPath(projected, splitProjectionKey(key), resolvePath(record, key, keys));
  }
  return projected;
};

export const applyProjectResultKeys = (
  schema: unknown,
  encoded: unknown,
  keys: readonly string[] | undefined,
): unknown => {
  if (keys === undefined) return encoded;
  const record = requirePlainObject(encoded, keys);
  const available = listSelectableResultKeys(schema);
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return throwDuplicateKey(keys, available);
    seen.add(key);
    const firstSegment = splitProjectionKey(key)[0];
    if (firstSegment === undefined || !available.includes(firstSegment)) {
      return throwJsonProjectionError({
        message: "Unknown projection key.",
        keys,
        available,
        reason: JSON_PROJECTION_REASONS.unknown_key,
        remediation: "Pass a key from the command result.",
      });
    }
  }

  return projectEncodedResult(
    record,
    keys.filter((key) => key.includes(PATH_SEPARATOR) || Object.hasOwn(record, key)),
  );
};
