import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of a string (hashed as UTF-8) or raw bytes. */
export const sha256Hex = (payload: Uint8Array | string): string =>
  createHash("sha256").update(payload).digest("hex");

/**
 * Serialize acyclic JSON data with object keys sorted by UTF-16 code unit and ordered arrays.
 * Undefined object properties are omitted, while absent array/root values become
 * null, matching JSON's array convention. Non-JSON inputs may throw TypeError.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${Array.from(value, (item: unknown) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
