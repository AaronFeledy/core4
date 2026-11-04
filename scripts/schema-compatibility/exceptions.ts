import { SchemaCompatibilityInputError, parseJson } from "../schema-compatibility-artifacts.ts";
import type { CompatibilityException, JsonValue, PersistedStateRef } from "./model.ts";
import { isJsonObject } from "./model.ts";

const parsePersistedState = (value: JsonValue, source: string): PersistedStateRef => {
  if (
    !isJsonObject(value) ||
    (value.store !== "applied-state" && value.store !== "tunnel-registry") ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1
  ) {
    throw new SchemaCompatibilityInputError(
      `${source} has invalid persistedState; expected { store: "applied-state"|"tunnel-registry", version: positive integer }.`,
    );
  }
  return { store: value.store, version: value.version };
};

export const parseCompatibilityExceptions = (
  text: string,
  source: string,
): ReadonlyArray<CompatibilityException> => {
  const value = parseJson(text, source);
  if (!Array.isArray(value)) throw new SchemaCompatibilityInputError(`${source} must contain an array.`);
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
      throw new SchemaCompatibilityInputError(`${source} contains an invalid compatibility exception.`);
    }
    const key = `${entry.surface}\0${entry.changeKind}\0${entry.path}`;
    if (seen.has(key)) {
      throw new SchemaCompatibilityInputError(
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

export const loadCompatibilityExceptions = async (
  path: string,
): Promise<ReadonlyArray<CompatibilityException>> =>
  parseCompatibilityExceptions(await Bun.file(path).text(), path);
