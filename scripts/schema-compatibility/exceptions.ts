import type { CompatibilityException, JsonValue, PersistedStateRef } from "./model.ts";
import { isJsonObject } from "./model.ts";

export class CompatibilityExceptionsError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "CompatibilityExceptionsError";
  }
}

const parsePersistedState = (value: JsonValue, source: string): PersistedStateRef => {
  if (
    !isJsonObject(value) ||
    (value.store !== "applied-state" && value.store !== "tunnel-registry") ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1
  ) {
    throw new CompatibilityExceptionsError(
      `${source} has invalid persistedState; expected { store: "applied-state"|"tunnel-registry", version: positive integer }.`,
    );
  }
  return { store: value.store, version: value.version };
};

const parseJsonValue = (value: unknown, source: string): JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => parseJsonValue(entry, source));
  if (value !== null && typeof value === "object") {
    const parsed: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) parsed[key] = parseJsonValue(entry, source);
    return parsed;
  }
  throw new CompatibilityExceptionsError(`Invalid JSON value in ${source}.`);
};

export const parseCompatibilityExceptions = (
  text: string,
  source: string,
): ReadonlyArray<CompatibilityException> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CompatibilityExceptionsError(`Invalid JSON in ${source}.`, error.message);
    }
    throw error;
  }
  const value = parseJsonValue(parsed, source);
  if (!Array.isArray(value)) throw new CompatibilityExceptionsError(`${source} must contain an array.`);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (
      !isJsonObject(entry) ||
      typeof entry.surface !== "string" ||
      typeof entry.changeKind !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.justification !== "string" ||
      entry.justification.trim().length === 0
    ) {
      throw new CompatibilityExceptionsError(`${source} contains an invalid compatibility exception.`);
    }
    const key = `${entry.surface}\0${entry.changeKind}\0${entry.path}`;
    if (seen.has(key)) {
      throw new CompatibilityExceptionsError(
        `${source} contains duplicate exception ${entry.surface} ${entry.path}.`,
      );
    }
    seen.add(key);
    const persistedState =
      entry.persistedState === undefined
        ? undefined
        : Array.isArray(entry.persistedState)
          ? entry.persistedState.map((ref) => parsePersistedState(ref, source))
          : parsePersistedState(entry.persistedState, source);
    return {
      surface: entry.surface,
      changeKind: entry.changeKind,
      path: entry.path,
      justification: entry.justification,
      ...(persistedState === undefined ? {} : { persistedState }),
    };
  });
};

export const loadCompatibilityExceptionsFile = async (
  path: string,
): Promise<ReadonlyArray<CompatibilityException>> =>
  parseCompatibilityExceptions(await Bun.file(path).text(), path);
