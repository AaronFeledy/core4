import { types } from "node:util";

/** Test a whole field without invoking class serializers or traversing cycles. */
export const isJsonSafe = (value: unknown, ancestors = new Set<object>(), depth = 0): boolean => {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (types.isProxy(value)) return false;
  if (Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    return false;
  ancestors.add(value);
  const keys = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !isJsonSafe(descriptor.value, ancestors, depth + 1)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
};
