import { canonicalJson } from "@lando/sdk/digest";

// Cache inputs may carry native dates and bigint; arbitrary toJSON hooks are not invoked.
const normalizeCacheValue = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeCacheValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeCacheValue(child)]));
  }
  return value;
};

export const canonicalCacheJson = (value: unknown): string => canonicalJson(normalizeCacheValue(value));

export const compareFingerprintText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
