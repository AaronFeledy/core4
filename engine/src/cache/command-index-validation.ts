import type { NormalizedToolingArg, NormalizedToolingFlag, ToolingInputDeclaration } from "@lando/sdk/schema";
import * as Predicate from "effect/Predicate";
import type { AppCommandIndexPayload, CommandIndexEntry } from "./command-index.ts";

// v8 preserves sparse arrays and non-record objects; neither is canonical cache metadata.
const isCacheMapping = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && Object.getPrototypeOf(value) === Object.prototype;

const isDenseArray = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
};

const own = (value: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isStrings = (value: unknown): value is readonly string[] =>
  isDenseArray(value) && value.every(isString);

const isFlag = (value: unknown): value is NormalizedToolingFlag =>
  isCacheMapping(value) &&
  isString(own(value, "name")) &&
  typeof own(value, "boolean") === "boolean" &&
  typeof own(value, "required") === "boolean" &&
  typeof own(value, "sensitive") === "boolean" &&
  (!Object.hasOwn(value, "alias") || isString(value.alias)) &&
  (!Object.hasOwn(value, "description") || isString(value.description)) &&
  (!Object.hasOwn(value, "choices") ||
    (value.boolean === false && value.sensitive === false && isStrings(value.choices))) &&
  (!Object.hasOwn(value, "default") ||
    (value.sensitive === false &&
      (value.boolean ? typeof value.default === "boolean" : isString(value.default))));

const isArg = (value: unknown): value is NormalizedToolingArg => {
  if (!isCacheMapping(value)) return false;
  const order = own(value, "order");
  return (
    isString(own(value, "name")) &&
    isFiniteNumber(order) &&
    order >= 0 &&
    Number.isInteger(order) &&
    typeof own(value, "required") === "boolean" &&
    typeof own(value, "sensitive") === "boolean" &&
    (!Object.hasOwn(value, "description") || isString(value.description)) &&
    (!Object.hasOwn(value, "choices") || (value.sensitive === false && isStrings(value.choices))) &&
    (!Object.hasOwn(value, "default") || (value.sensitive === false && isString(value.default)))
  );
};

// Keep this private boundary aligned with SDK-normalized/encoded declarations in codec tests.
// SDK types erase here: decoding must not initialize Effect or the SDK schema runtime.
const isInput = (value: unknown): value is ToolingInputDeclaration => {
  if (!isCacheMapping(value)) return false;
  const flags = own(value, "flags");
  const args = own(value, "args");
  return (
    isDenseArray(flags) &&
    flags.every(isFlag) &&
    isDenseArray(args) &&
    args.every(isArg) &&
    typeof own(value, "acceptsArguments") === "boolean" &&
    isString(own(value, "revision"))
  );
};

const isEntry = (value: unknown): value is CommandIndexEntry =>
  isCacheMapping(value) &&
  isString(own(value, "id")) &&
  isString(own(value, "summary")) &&
  typeof own(value, "hidden") === "boolean" &&
  (!Object.hasOwn(value, "disabled") || (value.disabled === true && value.hidden === true)) &&
  (!Object.hasOwn(value, "service") || isString(value.service)) &&
  (!Object.hasOwn(value, "source") || value.source === "bun-script") &&
  (!Object.hasOwn(value, "input") || isInput(value.input));

const isAliasPolicy = (value: unknown): boolean => {
  if (!isCacheMapping(value)) return false;
  const custom = own(value, "custom");
  return (
    typeof own(value, "enabled") === "boolean" &&
    isStrings(own(value, "disabled")) &&
    isCacheMapping(custom) &&
    Object.values(custom).every(isString)
  );
};

const isReferencedFile = (value: unknown): boolean =>
  isCacheMapping(value) &&
  isString(own(value, "absolutePath")) &&
  isFiniteNumber(own(value, "size")) &&
  isFiniteNumber(own(value, "mtimeMs")) &&
  isString(own(value, "sha256"));

const isScript = (value: unknown): boolean =>
  isCacheMapping(value) && isString(own(value, "relativePath")) && isString(own(value, "sha256"));

const isVersionConstraint = (value: unknown): boolean => {
  if (!isCacheMapping(value) || !isString(own(value, "range")) || !isString(own(value, "source")))
    return false;
  const order = own(value, "order");
  switch (own(value, "layer")) {
    case "base":
      return order === 0;
    case "dist":
      return order === 1;
    case "upstream":
      return order === 2;
    case "canonical":
      return order === 3;
    case "local":
      return order === 4;
    case "user":
      return order === 5;
    default:
      return false;
  }
};

const hasCommonFields = (value: Readonly<Record<string, unknown>>): boolean => {
  const entries = own(value, "entries");
  return (
    isFiniteNumber(own(value, "schemaVersion")) &&
    isString(own(value, "landoVersion")) &&
    isFiniteNumber(own(value, "generatedAtMs")) &&
    isDenseArray(entries) &&
    entries.every(isEntry)
  );
};

export const isAppCommandIndexPayload = (value: unknown): value is AppCommandIndexPayload =>
  isCacheMapping(value) &&
  hasCommonFields(value) &&
  isString(own(value, "appName")) &&
  isString(own(value, "sourceFile")) &&
  isFiniteNumber(own(value, "sourceMtimeMs")) &&
  isFiniteNumber(own(value, "sourceSize")) &&
  (!Object.hasOwn(value, "sourceContentHash") || isString(value.sourceContentHash)) &&
  (!Object.hasOwn(value, "toolingFingerprint") || isString(value.toolingFingerprint)) &&
  (!Object.hasOwn(value, "entriesFingerprint") || isString(value.entriesFingerprint)) &&
  (!Object.hasOwn(value, "sourceLocalIncludePaths") || isStrings(value.sourceLocalIncludePaths)) &&
  (!Object.hasOwn(value, "sourceReferencedFiles") ||
    (isDenseArray(value.sourceReferencedFiles) && value.sourceReferencedFiles.every(isReferencedFile))) &&
  (!Object.hasOwn(value, "sourceScripts") ||
    (isDenseArray(value.sourceScripts) && value.sourceScripts.every(isScript))) &&
  (!Object.hasOwn(value, "versionConstraints") ||
    (isDenseArray(value.versionConstraints) && value.versionConstraints.every(isVersionConstraint))) &&
  (!Object.hasOwn(value, "aliasPolicy") || isAliasPolicy(value.aliasPolicy));
