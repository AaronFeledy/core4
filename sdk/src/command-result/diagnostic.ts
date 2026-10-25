import { types } from "node:util";
import { Result, Schema } from "effect";
import { TaggedErrorJson } from "../schema/machine-output.ts";
import { LandoInternalError } from "../errors/internal.ts";
import { isJsonSafe } from "./json-safe.ts";

export const internalErrorRemediation =
  "Rerun the command with --debug --trace. Debug diagnostics are written to stderr; runtime worker logs are in the reported logsDir. Include the command and diagnostics when reporting this failure at https://github.com/AaronFeledy/core4/issues. Remove secrets before sharing diagnostics.";

const ownValue = (value: object | undefined, key: string): unknown => {
  if (value === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const reserved = new Set([
  "_tag", "name", "message", "stack", "cause", "remediation", "reason", "issues", "steps",
  "redactionTokens", "additionalErrors", "role",
]);

export const taggedErrorJson = (error: unknown): typeof TaggedErrorJson.Type => {
  const record = error !== null && typeof error === "object" && !types.isProxy(error) ? error : undefined;
  const tag = text(ownValue(record, "_tag"));
  const message = text(ownValue(record, "message")) ?? (typeof error === "string" ? error : "An internal Lando error occurred.");
  const base = {
    _tag: tag ?? "LandoInternalError",
    message: message.split(/\n\s+at /u)[0] ?? "An internal Lando error occurred.",
    remediation: text(ownValue(record, "remediation")) ?? internalErrorRemediation,
  };
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(record ?? {}).slice(0, 256)) {
    if (reserved.has(key)) continue;
    const value = ownValue(record, key);
    if (!isJsonSafe(value)) continue;
    if (key === "service" && text(value) === undefined) continue;
    extra[key] = value;
  }
  for (const key of ["reason", "issues", "steps"] as const) {
    const decoded = Schema.decodeUnknownResult(TaggedErrorJson.schema.fields[key])(ownValue(record, key));
    if (Result.isSuccess(decoded) && decoded.success !== undefined) extra[key] = decoded.success;
  }
  return { ...extra, ...base };
};

export const internalError = (error: unknown): LandoInternalError => {
  const diagnostic = taggedErrorJson(error);
  return new LandoInternalError({ message: diagnostic.message, remediation: internalErrorRemediation });
};
