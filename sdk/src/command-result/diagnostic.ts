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
  "failures",
]);

const projectTaggedError = (error: unknown, ancestors: readonly unknown[]): typeof TaggedErrorJson.Type => {
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
  const failures = ownValue(record, "failures");
  if (Array.isArray(failures) && !types.isProxy(failures) && ancestors.length < 8) {
    const members: (typeof TaggedErrorJson.Type)[] = [];
    for (let index = 0; index < failures.length; index++) {
      const member = ownValue(failures, String(index));
      if (
        member !== null &&
        typeof member === "object" &&
        text(ownValue(member, "_tag")) !== undefined &&
        member !== error &&
        !ancestors.includes(member)
      )
        members.push(projectTaggedError(member, [...ancestors, error]));
    }
    extra.failures = members;
  }
  return { ...extra, ...base };
};

export const taggedErrorJson = (error: unknown): typeof TaggedErrorJson.Type => projectTaggedError(error, []);

/** A tagged error that surfaced as a defect still has its own message and remediation. */
const isDiagnosticError = (error: unknown): boolean => {
  const record = error !== null && typeof error === "object" ? error : undefined;
  return (["_tag", "message", "remediation"] as const).every(
    (key) => text(ownValue(record, key)) !== undefined,
  );
};

/**
 * Presents an unexpected defect: a tagged error that was raised as a defect keeps its tag and
 * remediation, and any other value becomes a `LandoInternalError` that never carries its stack.
 */
export const normalizeDefect = (error: unknown): unknown => {
  if (isDiagnosticError(error)) return error;
  return new LandoInternalError({
    message: taggedErrorJson(error).message,
    remediation: internalErrorRemediation,
  });
};
