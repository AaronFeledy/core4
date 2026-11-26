import { SchemaCompatibilityInputError, parseJson } from "../schema-compatibility-artifacts.ts";
import { FINGERPRINT_PATTERN } from "./fingerprint.ts";
import type { CompatibilityException, CompatibilityLocation, JsonValue, PersistedStateRef } from "./model.ts";
import { isJsonObject, isPersistedStoreId } from "./model.ts";

const parsePersistedState = (value: JsonValue, source: string): PersistedStateRef => {
  if (
    !isJsonObject(value) ||
    !isPersistedStoreId(value.store) ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1
  ) {
    throw new SchemaCompatibilityInputError(
      `${source} has invalid persistedState; expected { store: registered persisted store id, version: positive integer }.`,
    );
  }
  return { store: value.store, version: value.version };
};

const ENTRY_KEYS = new Set(["fingerprint", "changeKind", "locations", "justification", "persistedState"]);

const parseLocations = (
  value: JsonValue | undefined,
  source: string,
): ReadonlyArray<CompatibilityLocation> => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SchemaCompatibilityInputError(`${source} has an exception without locations.`);
  }
  const seen = new Set<string>();
  return value.map((location) => {
    if (
      !isJsonObject(location) ||
      Object.keys(location).length !== 2 ||
      typeof location.surface !== "string" ||
      typeof location.path !== "string"
    ) {
      throw new SchemaCompatibilityInputError(
        `${source} has an invalid location; expected { surface, path }.`,
      );
    }
    const key = `${location.surface}\0${location.path}`;
    if (seen.has(key)) {
      throw new SchemaCompatibilityInputError(
        `${source} repeats location ${location.surface} ${location.path} in one exception.`,
      );
    }
    seen.add(key);
    return { surface: location.surface, path: location.path };
  });
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
      Object.keys(entry).some((key) => !ENTRY_KEYS.has(key)) ||
      typeof entry.fingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(entry.fingerprint) ||
      typeof entry.changeKind !== "string" ||
      typeof entry.justification !== "string" ||
      entry.justification.trim().length === 0
    ) {
      throw new SchemaCompatibilityInputError(
        `${source} contains an invalid compatibility exception; expected { fingerprint, changeKind, locations, justification, persistedState? } as printed by check:schema-compatibility.`,
      );
    }
    if (seen.has(entry.fingerprint)) {
      throw new SchemaCompatibilityInputError(
        `${source} contains duplicate exception ${entry.fingerprint}; merge its locations into one entry.`,
      );
    }
    seen.add(entry.fingerprint);
    const locations = parseLocations(entry.locations, source);
    const persistedState =
      entry.persistedState === undefined
        ? undefined
        : Array.isArray(entry.persistedState)
          ? entry.persistedState.map((ref) => parsePersistedState(ref, source))
          : parsePersistedState(entry.persistedState, source);
    return {
      fingerprint: entry.fingerprint,
      changeKind: entry.changeKind,
      locations,
      justification: entry.justification,
      ...(persistedState === undefined ? {} : { persistedState }),
    };
  });
};

export const loadCompatibilityExceptions = async (
  path: string,
): Promise<ReadonlyArray<CompatibilityException>> =>
  parseCompatibilityExceptions(await Bun.file(path).text(), path);
