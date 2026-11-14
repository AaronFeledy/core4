import type { CommandLoadError } from "./command-index.ts";

export const cacheMapping = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
export const exactCacheKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const denseArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value) &&
  Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
const path = (value: unknown): boolean =>
  denseArray(value) &&
  value.every((part) => typeof part === "string" || (typeof part === "number" && Number.isFinite(part)));
const optionalText = (value: Readonly<Record<string, unknown>>, key: string) =>
  !Object.hasOwn(value, key) || typeof value[key] === "string";
const source = (value: unknown): boolean => {
  if (!cacheMapping(value) || !path(value.path)) return false;
  switch (value.layer) {
    case "base":
    case "dist":
    case "upstream":
    case "canonical":
    case "local":
    case "user":
    case "config-file":
    case "config-drop-in":
    case "script":
      return exactCacheKeys(value, ["layer", "path", "file"]) && typeof value.file === "string";
    case "env":
      return exactCacheKeys(value, ["layer", "path", "variable"]) && typeof value.variable === "string";
    case "host":
    case "default":
      return exactCacheKeys(value, ["layer", "path"]);
    default:
      return false;
  }
};
const location = (value: unknown): boolean =>
  cacheMapping(value) &&
  exactCacheKeys(value, ["path", "source"]) &&
  path(value.path) &&
  (!Object.hasOwn(value, "source") || source(value.source));
const issue = (value: unknown): boolean =>
  cacheMapping(value) &&
  exactCacheKeys(value, ["path", "source", "message", "suggestion", "rule", "kind", "reason", "related"]) &&
  path(value.path) &&
  typeof value.message === "string" &&
  ["suggestion", "reason"].every((key) => optionalText(value, key)) &&
  (!Object.hasOwn(value, "rule") || value.rule === "landofile.tooling") &&
  (!Object.hasOwn(value, "kind") ||
    ["type", "value", "missing", "unexpected"].some((kind) => kind === value.kind)) &&
  (!Object.hasOwn(value, "source") || source(value.source)) &&
  (!Object.hasOwn(value, "related") || (denseArray(value.related) && value.related.every(location)));

export const isCommandLoadError = (value: unknown): value is CommandLoadError => {
  if (
    !cacheMapping(value) ||
    typeof value._tag !== "string" ||
    typeof value.message !== "string" ||
    Buffer.byteLength(JSON.stringify(value.message)) > 1024 ||
    !optionalText(value, "remediation") ||
    (typeof value.remediation === "string" && Buffer.byteLength(JSON.stringify(value.remediation)) > 1024)
  )
    return false;
  const valid =
    value._tag !== "ToolingCompileError"
      ? exactCacheKeys(value, ["_tag", "message", "remediation"])
      : exactCacheKeys(value, [
          "_tag",
          "tool",
          "source",
          "message",
          "remediation",
          "issues",
          "omittedIssueCount",
        ]) &&
        typeof value.tool === "string" &&
        Buffer.byteLength(JSON.stringify(value.tool)) <= 1024 &&
        typeof value.remediation === "string" &&
        denseArray(value.issues) &&
        value.issues.length <= 8 &&
        value.issues.every(issue) &&
        typeof value.omittedIssueCount === "number" &&
        Number.isSafeInteger(value.omittedIssueCount) &&
        value.omittedIssueCount >= 0 &&
        (!Object.hasOwn(value, "source") ||
          (cacheMapping(value.source) &&
            exactCacheKeys(value.source, ["path", "task"]) &&
            typeof value.source.path === "string" &&
            typeof value.source.task === "string"));
  return valid && Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024;
};
