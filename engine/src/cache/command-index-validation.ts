import type {
  NormalizedToolingArg,
  NormalizedToolingFlag,
  ToolingInputDeclaration,
  ToolingRunSummary,
  ToolingRunTarget,
} from "@lando/sdk/schema";
import {
  exactCacheKeys,
  cacheMapping as isCacheMapping,
  isCommandLoadError,
  denseArray as isDenseArray,
} from "./command-diagnostic-validation.ts";
import type { AppCommandIndexPayload, CommandIndexEntry } from "./command-index.ts";

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

const isRunTarget = (value: unknown): value is ToolingRunTarget => {
  if (!isCacheMapping(value)) return false;
  switch (own(value, "kind")) {
    case "host":
    case "primary":
    case "dynamic":
      return true;
    case "service":
      return isString(own(value, "name"));
    case "flag":
      return isString(own(value, "flag"));
    default:
      return false;
  }
};

const isRuns = (value: unknown): value is ToolingRunSummary => {
  if (!isCacheMapping(value)) return false;
  switch (own(value, "kind")) {
    case "script":
      return isString(value.path) && value.path.length <= 512;
    case "commands": {
      const steps = own(value, "steps");
      const targets = own(value, "targets");
      return (
        isFiniteNumber(steps) &&
        Number.isInteger(steps) &&
        steps >= 1 &&
        steps <= 1000 &&
        isDenseArray(targets) &&
        targets.length >= 1 &&
        targets.length <= 32 &&
        targets.every(isRunTarget) &&
        new Set(
          targets.map((target) => {
            switch (target.kind) {
              case "service":
                return `service:${target.name}`;
              case "flag":
                return `flag:${target.flag}`;
              case "host":
              case "primary":
              case "dynamic":
                return target.kind;
              default:
                return target satisfies never;
            }
          }),
        ).size === targets.length &&
        (!Object.hasOwn(value, "program") ||
          (isString(value.program) && value.program.length >= 1 && value.program.length <= 64))
      );
    }
    default:
      return false;
  }
};

const isEntry = (value: unknown): value is CommandIndexEntry => {
  if (
    !isCacheMapping(value) ||
    !isString(own(value, "id")) ||
    !isString(own(value, "summary")) ||
    !(own(value, "visibility") === "public" || own(value, "visibility") === "internal") ||
    !(own(value, "sourceKind") === "tooling" || own(value, "sourceKind") === "bun-script")
  )
    return false;
  const common = ["_tag", "id", "summary", "visibility", "sourceKind"];
  switch (own(value, "_tag")) {
    case "Ready":
      return (
        exactCacheKeys(value, [...common, "input", "service", "wrapper", "runs"]) &&
        isInput(own(value, "input")) &&
        (!Object.hasOwn(value, "service") || isString(value.service)) &&
        (!Object.hasOwn(value, "wrapper") || value.wrapper === true) &&
        (!Object.hasOwn(value, "runs") || isRuns(value.runs))
      );
    case "Disabled": {
      const source = own(value, "source");
      return (
        exactCacheKeys(value, [...common, "source"]) &&
        isCacheMapping(source) &&
        exactCacheKeys(source, ["path", "task"]) &&
        isString(own(source, "path")) &&
        isString(own(source, "task"))
      );
    }
    case "Unavailable":
      return exactCacheKeys(value, [...common, "diagnostic"]) && isCommandLoadError(own(value, "diagnostic"));
    default:
      return false;
  }
};

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
  isCacheMapping(value) &&
  isString(own(value, "relativePath")) &&
  (Object.hasOwn(value, "invalid")
    ? isString(value.invalid) && !Object.hasOwn(value, "sha256")
    : isString(own(value, "sha256")));

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
