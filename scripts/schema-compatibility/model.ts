import { INTERNAL_PERSISTED_STORES, type InternalPersistedStoreId } from "./internal-stores.ts";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonSchema = JsonObject;

export type SchemaPolarity = "input" | "output" | "strict";
export type CompatibilityVerdict = "compatible" | "breaking" | "unknown";

export interface CompatibilityFinding {
  readonly verdict: CompatibilityVerdict;
  readonly changeKind: string;
  readonly path: string;
  readonly message: string;
  /** Digest of the change kind plus the normalized before/after values the finding judged. */
  readonly fingerprint: string;
  readonly accepted: boolean;
  readonly justification?: string;
  readonly persistedWidening?: "version-only" | "review";
}

export type PublishedPersistedStoreId = "applied-state" | "tunnel-registry";
export type PersistedStoreId = PublishedPersistedStoreId | InternalPersistedStoreId;

export const isPersistedStoreId = (value: unknown): value is PersistedStoreId =>
  value === "applied-state" ||
  value === "tunnel-registry" ||
  INTERNAL_PERSISTED_STORES.some(({ id }) => id === value);

export interface PersistedStateRef {
  readonly store: PersistedStoreId;
  readonly version: number;
}

export interface CompatibilityLocation {
  readonly surface: string;
  readonly path: string;
}

/** One reviewed change, accepted only at the listed surface paths. */
export interface CompatibilityException {
  readonly fingerprint: string;
  readonly changeKind: string;
  readonly locations: ReadonlyArray<CompatibilityLocation>;
  readonly justification: string;
  readonly persistedState?: PersistedStateRef | ReadonlyArray<PersistedStateRef>;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

export const jsonEquals = (left: JsonValue | undefined, right: JsonValue | undefined): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined || typeof left !== typeof right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEquals(value, right[index]));
  }
  if (isJsonObject(left)) {
    if (!isJsonObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(left[key], right[key]))
    );
  }
  return false;
};

export const jsonValueKey = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(jsonValueKey).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonValueKey(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const stringArray = (value: JsonValue | undefined): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
