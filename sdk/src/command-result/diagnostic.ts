import { types } from "node:util";
import { Result, Schema } from "effect";
import { LandoInternalError } from "../errors/internal.ts";
import { TaggedErrorJson } from "../schema/machine-output.ts";
import { isJsonSafe } from "./json-safe.ts";

export const internalErrorRemediation =
  "Rerun the command with --debug --trace. Debug diagnostics are written to stderr; runtime worker logs are in the reported logsDir. Include the command and diagnostics when reporting this failure at https://github.com/AaronFeledy/core4/issues. Remove secrets before sharing diagnostics.";

const ownValue = (value: object | undefined, key: string): unknown => {
  if (value === undefined || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const reserved = new Set([
  "_tag",
  "name",
  "message",
  "stack",
  "cause",
  "remediation",
  "reason",
  "issues",
  "steps",
  "redactionTokens",
  "additionalErrors",
  "role",
]);

export const taggedErrorJson = (error: unknown): typeof TaggedErrorJson.Type => {
  const record = error !== null && typeof error === "object" && !types.isProxy(error) ? error : undefined;
  const tag = text(ownValue(record, "_tag"));
  const message =
    text(ownValue(record, "message")) ??
    (typeof error === "string" ? error : "An internal Lando error occurred.");
  const base = {
    _tag: tag ?? "LandoInternalError",
    message: message.split(/\n\s+at /u)[0] ?? "An internal Lando error occurred.",
    remediation: text(ownValue(record, "remediation")) ?? internalErrorRemediation,
  };
  const extra: Record<string, unknown> = {};
  const keys = new Set(Object.keys(record ?? {}));
  const prototype = record === undefined ? undefined : Object.getPrototypeOf(record);
  let schemaClass = ownValue(prototype ?? undefined, "constructor");
  for (let depth = 0; depth < 8 && typeof schemaClass === "function"; depth++) {
    if (types.isProxy(schemaClass)) break;
    const fields = ownValue(schemaClass, "fields");
    if (fields !== null && typeof fields === "object" && !types.isProxy(fields)) {
      for (const key of Object.keys(fields)) keys.add(key);
      break;
    }
    schemaClass = Object.getPrototypeOf(schemaClass);
  }
  for (const key of [...keys].slice(0, 256)) {
    if (reserved.has(key)) continue;
    const value = ownValue(record, key);
    if (!isJsonSafe(value)) continue;
    if (key === "service" && text(value) === undefined) continue;
    extra[key] = value;
  }
  for (const key of ["reason", "issues", "steps"] as const) {
    const value = ownValue(record, key);
    if (!isJsonSafe(value)) continue;
    const decoded = Schema.decodeUnknownResult(TaggedErrorJson.schema.fields[key])(value);
    if (Result.isSuccess(decoded) && decoded.success !== undefined) extra[key] = decoded.success;
  }
  return { ...extra, ...base };
};

export const internalError = (error: unknown): LandoInternalError => {
  const diagnostic = taggedErrorJson(error);
  return new LandoInternalError({ message: diagnostic.message, remediation: internalErrorRemediation });
};
