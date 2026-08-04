import { resolve } from "node:path";

import type {
  CompatibilityException,
  JsonSchema,
  JsonValue,
  SchemaPolarity,
} from "./schema-compatibility/model.ts";
import { isJsonObject } from "./schema-compatibility/model.ts";
import { schemaPolarity } from "./schema-compatibility/polarity.ts";

export interface SchemaArtifact {
  readonly surface: string;
  readonly polarity: SchemaPolarity;
  readonly schema: JsonSchema;
}

export type SchemaArtifactSet = ReadonlyMap<string, SchemaArtifact>;
export type SchemaArtifactFamily = "sdk" | "command";

export interface BaseSchemaArtifacts {
  readonly artifacts: SchemaArtifactSet;
  readonly unavailableFamilies: ReadonlyArray<SchemaArtifactFamily>;
}

export class SchemaCompatibilityInputError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SchemaCompatibilityInputError";
  }
}

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
  throw new SchemaCompatibilityInputError(`Invalid JSON value in ${source}.`);
};

const parseJson = (text: string, source: string): JsonValue => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SchemaCompatibilityInputError(`Invalid JSON in ${source}.`, error.message);
    }
    throw error;
  }
  return parseJsonValue(parsed, source);
};

const parseSchema = (text: string, source: string): JsonSchema => {
  const parsed = parseJson(text, source);
  if (!isJsonObject(parsed))
    throw new SchemaCompatibilityInputError(`${source} must contain a JSON object schema.`);
  return parsed;
};

const metadataEntries = (index: JsonValue, source: string): ReadonlyArray<readonly [string, string]> => {
  if (!Array.isArray(index)) throw new SchemaCompatibilityInputError(`${source} must contain an array.`);
  return index.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || typeof entry.jsonSchemaPath !== "string") {
      throw new SchemaCompatibilityInputError(`${source} contains an invalid schema metadata entry.`);
    }
    return [entry.id, entry.jsonSchemaPath] as const;
  });
};

const commandEntries = (index: JsonValue, source: string): ReadonlyArray<readonly [string, string]> => {
  if (!isJsonObject(index)) throw new SchemaCompatibilityInputError(`${source} must contain an object.`);
  return Object.entries(index).map(([commandId, artifactPath]) => {
    if (typeof artifactPath !== "string") {
      throw new SchemaCompatibilityInputError(`${source} maps ${commandId} to a non-string path.`);
    }
    return [commandId, artifactPath] as const;
  });
};

const addArtifact = (artifacts: Map<string, SchemaArtifact>, artifact: SchemaArtifact): void => {
  if (artifacts.has(artifact.surface)) {
    throw new SchemaCompatibilityInputError(`Duplicate schema surface ${artifact.surface}.`);
  }
  artifacts.set(artifact.surface, artifact);
};

export const loadWorkingSchemaArtifacts = async (repoRoot: string): Promise<SchemaArtifactSet> => {
  const artifacts = new Map<string, SchemaArtifact>();
  const schemaIndexPath = resolve(repoRoot, "dist/schemas/index.json");
  const schemaIndex = parseJson(await Bun.file(schemaIndexPath).text(), "dist/schemas/index.json");
  for (const [schemaId, artifactPath] of metadataEntries(schemaIndex, "dist/schemas/index.json")) {
    addArtifact(artifacts, {
      surface: `schema:${schemaId}`,
      polarity: schemaPolarity(schemaId),
      schema: parseSchema(await Bun.file(resolve(repoRoot, artifactPath)).text(), artifactPath),
    });
  }
  const commandIndexPath = resolve(repoRoot, "dist/command-schemas/index.json");
  const commandIndex = parseJson(await Bun.file(commandIndexPath).text(), "dist/command-schemas/index.json");
  for (const [commandId, artifactPath] of commandEntries(commandIndex, "dist/command-schemas/index.json")) {
    addArtifact(artifacts, {
      surface: `command:${commandId}`,
      polarity: "output",
      schema: parseSchema(await Bun.file(resolve(repoRoot, artifactPath)).text(), artifactPath),
    });
  }
  return artifacts;
};

export const loadCompatibilityExceptions = async (
  path: string,
): Promise<ReadonlyArray<CompatibilityException>> => {
  const parsed = parseJson(await Bun.file(path).text(), path);
  if (!Array.isArray(parsed)) throw new SchemaCompatibilityInputError(`${path} must contain an array.`);
  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (
      !isJsonObject(entry) ||
      typeof entry.surface !== "string" ||
      typeof entry.changeKind !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.justification !== "string" ||
      entry.justification.trim().length === 0
    ) {
      throw new SchemaCompatibilityInputError(`${path} contains an invalid compatibility exception.`);
    }
    const key = `${entry.surface}\0${entry.changeKind}\0${entry.path}`;
    if (seen.has(key))
      throw new SchemaCompatibilityInputError(
        `${path} contains duplicate exception ${entry.surface} ${entry.path}.`,
      );
    seen.add(key);
    return {
      surface: entry.surface,
      changeKind: entry.changeKind,
      path: entry.path,
      justification: entry.justification,
    };
  });
};
