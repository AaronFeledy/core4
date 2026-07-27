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
  readonly accepted: boolean;
  readonly justification?: string;
}

export interface CompatibilityException {
  readonly surface: string;
  readonly changeKind: string;
  readonly path: string;
  readonly justification: string;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
