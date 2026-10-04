import { resolve } from "node:path";

import type { CompatibilityException } from "../../../scripts/schema-compatibility/classifier.ts";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/x-extension-closed-record.base.json");
export const EXTENSION_PATTERN = "^x-[\\s\\S]*?$";
const ANNOTATIONS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "x-deprecation",
]);

export const CONFIG_COMMANDS = [
  "app:config",
  "app:config:edit",
  "app:config:set",
  "app:config:unset",
  "app:config:validate",
  "meta:global:config",
  "meta:global:config:edit",
  "meta:global:config:set",
  "meta:global:config:unset",
  "meta:global:config:validate",
] as const;

export const NETWORK_SERVICE_CONFIGS = [
  "DotnetServiceConfig",
  "LocalStackServiceConfig",
  "MailhogServiceConfig",
  "MailpitServiceConfig",
  "MinIOServiceConfig",
  "MssqlServiceConfig",
  "MysqlServiceConfig",
  "PhpMyAdminServiceConfig",
  "PhpServiceConfig",
  "RabbitMQServiceConfig",
  "TomcatServiceConfig",
  "VarnishServiceConfig",
] as const;

export const CLOSED_EXTENSION_JUSTIFICATION =
  "Base JSON Schema artifacts for a closed x-* extension object emitted propertyNames /^x-[\\s\\S]*?$/ beside declared properties, so every declared name fails that pattern. Embedded codegen bypassed the getJsonSchema repair. The current closed StructWithRest artifact is the intended contract: additionalProperties false, patternProperties of that same pattern, and no propertyNames. This records that artifact correction, not wire equivalence. Declared names stay accepted, x- extensions including newlines stay accepted, and other unknown keys stay rejected.";

export interface CapturedExtension {
  readonly provenanceCommit: string;
  readonly pattern: string;
  readonly landofile: JsonSchema;
  readonly networks: JsonSchema;
  readonly contextPropertyNames: JsonSchema;
  readonly contextPropertyKeys: readonly string[];
  readonly contextBodySha256: string;
}

const requireObject = (value: unknown, label: string): JsonSchema => {
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
};

const readKeys = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw new Error("contextPropertyKeys must be an array");
  const keys: string[] = [];
  for (const key of value) {
    if (typeof key !== "string") throw new Error("contextPropertyKeys must be strings");
    keys.push(key);
  }
  return keys;
};

export const parseCapturedExtension = (value: unknown): CapturedExtension => {
  const root = requireObject(value, "fixture");
  const provenance = requireObject(root.provenance, "provenance");
  return {
    provenanceCommit: requireString(provenance.commit, "commit"),
    pattern: requireString(root.pattern, "pattern"),
    landofile: requireObject(root.landofile, "landofile"),
    networks: requireObject(root.networks, "networks"),
    contextPropertyNames: requireObject(root.contextPropertyNames, "contextPropertyNames"),
    contextPropertyKeys: readKeys(root.contextPropertyKeys),
    contextBodySha256: requireString(root.contextBodySha256, "contextBodySha256"),
  };
};

const isEmptyExtension = (value: JsonValue | undefined): boolean =>
  value === true || (isJsonObject(value) && Object.keys(value).every((key) => ANNOTATIONS.has(key)));

/** Signature of the embedded producer bug. Not a compatibility-normalizer identity. */
const isBuggyClosedExtension = (schema: JsonSchema): boolean => {
  const names = schema.propertyNames;
  if (!isJsonObject(names) || names.pattern !== EXTENSION_PATTERN) return false;
  if (names.type !== undefined && names.type !== "string") return false;
  if (!Object.keys(names).every((key) => key === "pattern" || key === "type")) return false;
  if (!isJsonObject(schema.properties) || Object.keys(schema.properties).length === 0) return false;
  if (schema.additionalProperties !== undefined || schema.unevaluatedProperties !== undefined) return false;
  const patterns = schema.patternProperties;
  if (patterns === undefined) return true;
  if (!isJsonObject(patterns)) return false;
  const keys = Object.keys(patterns);
  const only = keys[0];
  return keys.length === 1 && only === "" && isEmptyExtension(patterns[only]);
};

export const repairClosedExtension = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(repairClosedExtension);
  if (!isJsonObject(value)) return value;
  if (!isBuggyClosedExtension(value)) {
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = repairClosedExtension(child);
    return next;
  }
  const next: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "propertyNames" || key === "patternProperties") continue;
    next[key] = repairClosedExtension(child);
  }
  next.additionalProperties = false;
  next.patternProperties = { [EXTENSION_PATTERN]: {} };
  return next;
};

export const schemaAt = (schema: JsonSchema, path: string): JsonSchema => {
  let cursor = schema;
  for (const segment of path.split(".").slice(1)) {
    const direct = cursor[segment];
    if (isJsonObject(direct)) {
      cursor = direct;
      continue;
    }
    const properties = cursor.properties;
    const property = isJsonObject(properties) ? properties[segment] : undefined;
    if (!isJsonObject(property)) throw new Error(`missing ${path} at ${segment}`);
    cursor = property;
  }
  return cursor;
};

const artifactPath = (index: unknown, surface: string): string => {
  if (surface.startsWith("command:")) {
    const commandId = surface.slice("command:".length);
    return requireString(requireObject(index, "command index")[commandId], surface);
  }
  const schemaId = surface.slice("schema:".length);
  if (!Array.isArray(index)) throw new Error("schema index must be an array");
  for (const entry of index) {
    const row = requireObject(entry, "schema index entry");
    if (row.id === schemaId) return requireString(row.jsonSchemaPath, surface);
  }
  throw new Error(`missing schema ${schemaId}`);
};

export const loadNormalizedArtifact = async (surface: string): Promise<JsonSchema> => {
  const indexName = surface.startsWith("command:")
    ? "dist/command-schemas/index.json"
    : "dist/schemas/index.json";
  const index = await Bun.file(resolve(REPO_ROOT, indexName)).json();
  const relativePath = artifactPath(index, surface);
  return normalizeJsonSchema(requireObject(await Bun.file(resolve(REPO_ROOT, relativePath)).json(), surface));
};

/** Drops the extension keywords and direct property unions so only the shared body is hashed. */
export const blankContextBody = (value: JsonValue, path = "$"): JsonValue => {
  if (Array.isArray(value)) return value.map((child, index) => blankContextBody(child, `${path}[${index}]`));
  if (!isJsonObject(value)) return value;
  const next: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      path === "$" &&
      (key === "additionalProperties" || key === "patternProperties" || key === "propertyNames")
    ) {
      continue;
    }
    if (path.startsWith("$.properties.") && key === "anyOf" && path.split(".").length === 3) {
      next[key] = "RESIDUAL";
      continue;
    }
    next[key] = blankContextBody(child, childPath);
  }
  return next;
};

export const admitsExtensionKey = (schema: JsonSchema, key: string): boolean => {
  const properties = schema.properties;
  if (isJsonObject(properties) && Object.hasOwn(properties, key)) return true;
  const patterns = schema.patternProperties;
  if (isJsonObject(patterns)) {
    for (const pattern of Object.keys(patterns)) {
      if (new RegExp(pattern).test(key)) return true;
    }
  }
  return schema.additionalProperties !== false;
};

export const admitsDeclaredName = (schema: JsonSchema, value: JsonValue): boolean => {
  const properties = schema.properties;
  const name = isJsonObject(properties) ? properties.name : undefined;
  return isJsonObject(name) && name.type === "string" && typeof value === "string";
};

const keywordException = (surface: string, path: string): CompatibilityException => ({
  surface,
  changeKind: "unsupported-keyword",
  path,
  justification: CLOSED_EXTENSION_JUSTIFICATION,
});

export const expectedClosedExtensionExceptions = (): ReadonlyArray<CompatibilityException> => {
  const entries: CompatibilityException[] = [];
  for (const command of CONFIG_COMMANDS) {
    const surface = `command:${command}`;
    entries.push(
      keywordException(surface, "$.landofile.additionalProperties"),
      keywordException(surface, "$.landofile.patternProperties"),
      keywordException(surface, "$.landofile.propertyNames"),
      keywordException(surface, "$.landofile.services.additionalProperties"),
    );
  }
  for (const path of [
    "$.landofile.additionalProperties",
    "$.landofile.patternProperties",
    "$.landofile.propertyNames",
    "$.landofile.services.additionalProperties",
  ]) {
    entries.push(keywordException("schema:TemplateRenderContext", path));
  }
  entries.push(
    keywordException("schema:ConfigTranslateEncodeInput", "$.context.additionalProperties"),
    keywordException("schema:ConfigTranslateEncodeInput", "$.context.patternProperties"),
    keywordException("schema:ConfigTranslateEncodeInput", "$.context.propertyNames"),
    keywordException("schema:LandofileShape", "$.services.additionalProperties"),
  );
  for (const schemaId of NETWORK_SERVICE_CONFIGS) {
    entries.push({
      surface: `schema:${schemaId}`,
      changeKind: "unsupported-construct",
      path: "$.networks.anyOf",
      justification: CLOSED_EXTENSION_JUSTIFICATION,
    });
  }
  return entries;
};

export const exceptionKey = (surface: string, changeKind: string, path: string): string =>
  `${surface}\0${changeKind}\0${path}`;
