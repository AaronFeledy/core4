import { Effect, Either } from "effect";

import { LandofileExpressionEvalError, LandofileExpressionForbiddenError } from "../errors/index.ts";
import type { ExpressionNode, ExpressionTemplate, PathSegment, ShellParamSegment } from "./ast.ts";
import type { ExpressionContext } from "./context.ts";

export interface EvaluateExpressionOptions {
  readonly filePath?: string | undefined;
}

export type LandofileExpressionEvaluationError =
  | LandofileExpressionForbiddenError
  | LandofileExpressionEvalError;

type MissingValue = typeof MISSING;
type ResolvedValue = unknown | MissingValue;
type Helper = (args: ReadonlyArray<ResolvedValue>, state: EvaluationState) => ResolvedValue;

interface EvaluationState {
  readonly context: ExpressionContext;
  readonly options: EvaluateExpressionOptions;
}

interface SemverVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const MISSING = Symbol("lando.expression.missing");
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_HELPERS = new Set([
  "load",
  "import",
  "text",
  "bytes",
  "hash",
  "which",
  "glob",
  "fs.exists",
  "fs.isFile",
  "fs.isDir",
  "fs.size",
]);
const UNSUPPORTED_DECODERS = new Set(["yaml", "fromYaml", "fromToml"]);
const EVAL_REMEDIATION = "Check the expression and the context values available to the sandboxed evaluator.";
const FORBIDDEN_REMEDIATION =
  "Use a pre-materialized value from the expression context instead of this helper.";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = new Map([...BASE64_ALPHABET].map((char, index) => [char, index] as const));

const isMissing = (value: ResolvedValue): value is MissingValue => value === MISSING;
const isUnavailable = (value: ResolvedValue): boolean => isMissing(value) || value === undefined;
const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const optionalFilePath = (options: EvaluateExpressionOptions): { readonly filePath?: string } =>
  options.filePath === undefined ? {} : { filePath: options.filePath };

const evalError = (message: string, options: EvaluateExpressionOptions): LandofileExpressionEvalError =>
  new LandofileExpressionEvalError({
    message,
    ...optionalFilePath(options),
    remediation: EVAL_REMEDIATION,
  });

const forbiddenError = (
  helper: string,
  options: EvaluateExpressionOptions,
): LandofileExpressionForbiddenError =>
  new LandofileExpressionForbiddenError({
    message: `Expression helper "${helper}" is not available in the sandboxed evaluator.`,
    helper,
    ...optionalFilePath(options),
    remediation: FORBIDDEN_REMEDIATION,
  });

const unsupportedDecoderError = (
  helper: string,
  options: EvaluateExpressionOptions,
): LandofileExpressionEvalError =>
  evalError(`Decoder "${helper}" is not supported in the sandboxed evaluator.`, options);

const isEvaluationError = (cause: unknown): cause is LandofileExpressionEvaluationError =>
  cause instanceof LandofileExpressionForbiddenError || cause instanceof LandofileExpressionEvalError;

const wrapUnknownEvaluationError = (
  options: EvaluateExpressionOptions,
  cause: unknown,
): LandofileExpressionEvaluationError =>
  isEvaluationError(cause)
    ? cause
    : evalError("Failed to evaluate Landofile expression in the sandboxed evaluator.", options);

const assertArgCount = (
  helper: string,
  args: ReadonlyArray<ResolvedValue>,
  state: EvaluationState,
  min: number,
  max = min,
): void => {
  if (args.length < min || args.length > max) {
    throw evalError(`Helper "${helper}" received an unsupported number of arguments.`, state.options);
  }
};

const callNodeArg = (
  helper: string,
  nodes: ReadonlyArray<ExpressionNode>,
  state: EvaluationState,
  index: number,
): ExpressionNode => {
  const node = nodes[index];
  if (node === undefined) {
    throw evalError(`Helper "${helper}" received an unsupported number of arguments.`, state.options);
  }
  return node;
};

const requireResolved = (
  value: ResolvedValue,
  state: EvaluationState,
  message = "Expression resolved to a missing value.",
): unknown => {
  if (isUnavailable(value)) {
    throw evalError(message, state.options);
  }
  rejectUnsafeValue(value, state);
  return value;
};

const rejectUnsafeValue = (value: unknown, state: EvaluationState): void => {
  if (typeof value === "function" || typeof value === "symbol") {
    throw evalError(
      "Expression traversal encountered a value that is not allowed in the sandbox.",
      state.options,
    );
  }
};

const ensureAllowedKey = (key: string, state: EvaluationState): void => {
  if (BLOCKED_KEYS.has(key)) {
    throw evalError("Expression path segment is not allowed in the sandbox.", state.options);
  }
};

const readOwnEnumerable = (target: unknown, key: string, state: EvaluationState): ResolvedValue => {
  ensureAllowedKey(key, state);
  if (isUnavailable(target as ResolvedValue)) return MISSING;
  rejectUnsafeValue(target, state);

  if (Array.isArray(target) && /^\d+$/.test(key)) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= target.length) return MISSING;
    const value = target[index];
    rejectUnsafeValue(value, state);
    return value;
  }

  if (!isRecordLike(target)) {
    throw evalError(
      "Expression path access attempted to read a property from a non-object value.",
      state.options,
    );
  }

  if (!Object.prototype.propertyIsEnumerable.call(target, key)) return MISSING;
  const value = target[key];
  rejectUnsafeValue(value, state);
  return value;
};

const readIndex = (target: unknown, index: number, state: EvaluationState): ResolvedValue => {
  if (!Number.isInteger(index) || index < 0) {
    throw evalError("Expression path index must be a non-negative integer.", state.options);
  }

  if (isUnavailable(target as ResolvedValue)) return MISSING;
  rejectUnsafeValue(target, state);

  if (Array.isArray(target)) {
    if (index >= target.length) return MISSING;
    const value = target[index];
    rejectUnsafeValue(value, state);
    return value;
  }

  return readOwnEnumerable(target, String(index), state);
};

const readDynamicSegment = (target: unknown, segment: PathSegment, state: EvaluationState): ResolvedValue => {
  if (segment.type === "prop") return readOwnEnumerable(target, segment.name, state);
  if (segment.type === "key") return readOwnEnumerable(target, segment.key, state);
  if (segment.type === "index") return readIndex(target, segment.index, state);

  const key = requireResolved(
    resolveNode(segment.expr, state),
    state,
    "Dynamic path segment resolved to a missing value.",
  );
  if (typeof key === "number") return readIndex(target, key, state);
  if (typeof key === "string") return readOwnEnumerable(target, key, state);
  throw evalError("Dynamic path segment must resolve to a string or number.", state.options);
};

const resolveSegments = (
  target: ResolvedValue,
  segments: ReadonlyArray<PathSegment>,
  state: EvaluationState,
): ResolvedValue => {
  let current = target;
  for (const segment of segments) {
    if (isMissing(current)) return MISSING;
    current = readDynamicSegment(current, segment, state);
  }
  return current;
};

const resolvePath = (
  node: Extract<ExpressionNode, { readonly kind: "Path" }>,
  state: EvaluationState,
): ResolvedValue => {
  const head = readOwnEnumerable(state.context, node.head, state);
  return resolveSegments(head, node.segments, state);
};

const resolveNode = (node: ExpressionNode, state: EvaluationState): ResolvedValue => {
  switch (node.kind) {
    case "Literal":
      return node.value;
    case "ArrayLiteral":
      return node.elements.map((element) => requireResolved(resolveNode(element, state), state));
    case "ObjectLiteral":
      return Object.fromEntries(
        node.entries.map((entry) => [entry.key, requireResolved(resolveNode(entry.value, state), state)]),
      );
    case "Path":
      return resolvePath(node, state);
    case "Access": {
      const target = resolveNode(node.target, state);
      return resolveSegments(target, node.segments, state);
    }
    case "Call":
      return evaluateCall(node.callee, node.args, state);
    case "Conditional": {
      const test = requireResolved(
        resolveNode(node.test, state),
        state,
        "Conditional test resolved to a missing value.",
      );
      return resolveNode(isTruthy(test) ? node.consequent : node.alternate, state);
    }
  }
};

const evaluateCall = (
  callee: string,
  nodes: ReadonlyArray<ExpressionNode>,
  state: EvaluationState,
): ResolvedValue => {
  if (callee === "fs" || callee.startsWith("fs.")) {
    throw forbiddenError(callee, state.options);
  }
  if (FORBIDDEN_HELPERS.has(callee)) {
    throw forbiddenError(callee, state.options);
  }
  if (UNSUPPORTED_DECODERS.has(callee)) {
    throw unsupportedDecoderError(callee, state.options);
  }

  const helper = HELPERS[callee];
  if (helper === undefined) {
    throw evalError(`Unknown expression helper "${callee}".`, state.options);
  }

  if (callee === "default") {
    assertArgCount("default", nodes, state, 2);
    const value = resolveNode(callNodeArg("default", nodes, state, 0), state);
    return isUnavailable(value)
      ? requireResolved(resolveNode(callNodeArg("default", nodes, state, 1), state), state)
      : value;
  }

  if (callee === "and") {
    assertArgCount("and", nodes, state, 2);
    const left = requireResolved(resolveNode(callNodeArg("and", nodes, state, 0), state), state);
    return isTruthy(left) ? resolveNode(callNodeArg("and", nodes, state, 1), state) : left;
  }

  if (callee === "or") {
    assertArgCount("or", nodes, state, 2);
    const left = requireResolved(resolveNode(callNodeArg("or", nodes, state, 0), state), state);
    return isTruthy(left) ? left : resolveNode(callNodeArg("or", nodes, state, 1), state);
  }

  return helper(
    nodes.map((node) => resolveNode(node, state)),
    state,
  );
};

const callHelperByName = (
  helperName: string,
  args: ReadonlyArray<ResolvedValue>,
  state: EvaluationState,
): ResolvedValue => {
  if (helperName === "fs" || helperName.startsWith("fs.") || FORBIDDEN_HELPERS.has(helperName)) {
    throw forbiddenError(helperName, state.options);
  }
  if (UNSUPPORTED_DECODERS.has(helperName)) {
    throw unsupportedDecoderError(helperName, state.options);
  }
  const helper = HELPERS[helperName];
  if (helper === undefined) {
    throw evalError(`Unknown expression helper "${helperName}".`, state.options);
  }
  return helper(args, state);
};

const isTruthy = (value: unknown): boolean => Boolean(value);

const asString = (helper: string, value: ResolvedValue, state: EvaluationState): string => {
  const resolved = requireResolved(value, state, `Helper "${helper}" received a missing value.`);
  if (typeof resolved !== "string") {
    throw evalError(`Helper "${helper}" expected a string value.`, state.options);
  }
  return resolved;
};

const asNumber = (helper: string, value: ResolvedValue, state: EvaluationState): number => {
  const resolved = requireResolved(value, state, `Helper "${helper}" received a missing value.`);
  if (typeof resolved !== "number" || Number.isNaN(resolved)) {
    throw evalError(`Helper "${helper}" expected a number value.`, state.options);
  }
  return resolved;
};

const asInteger = (helper: string, value: ResolvedValue, state: EvaluationState): number => {
  const number = asNumber(helper, value, state);
  if (!Number.isInteger(number)) {
    throw evalError(`Helper "${helper}" expected an integer value.`, state.options);
  }
  return number;
};

const asArray = (helper: string, value: ResolvedValue, state: EvaluationState): ReadonlyArray<unknown> => {
  const resolved = requireResolved(value, state, `Helper "${helper}" received a missing value.`);
  if (!Array.isArray(resolved)) {
    throw evalError(`Helper "${helper}" expected an array value.`, state.options);
  }
  return resolved;
};

const asObject = (helper: string, value: ResolvedValue, state: EvaluationState): Record<string, unknown> => {
  const resolved = requireResolved(value, state, `Helper "${helper}" received a missing value.`);
  if (!isRecordLike(resolved) || Array.isArray(resolved)) {
    throw evalError(`Helper "${helper}" expected an object value.`, state.options);
  }
  return resolved;
};

const optionalString = (value: ResolvedValue, state: EvaluationState, helper: string): string | undefined => {
  if (isUnavailable(value)) return undefined;
  return asString(helper, value, state);
};

const safeObjectEntries = (
  _helper: string,
  value: Record<string, unknown>,
  state: EvaluationState,
): ReadonlyArray<readonly [string, unknown]> =>
  Object.keys(value).map((key) => {
    ensureAllowedKey(key, state);
    const entryValue = value[key];
    rejectUnsafeValue(entryValue, state);
    return [key, entryValue] as const;
  });

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecordLike(left) && isRecordLike(right) && !Array.isArray(left) && !Array.isArray(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.prototype.propertyIsEnumerable.call(right, key) && deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
};

const compareValues = (
  helper: string,
  left: ResolvedValue,
  right: ResolvedValue,
  state: EvaluationState,
): number => {
  const resolvedLeft = requireResolved(left, state, `Helper "${helper}" received a missing value.`);
  const resolvedRight = requireResolved(right, state, `Helper "${helper}" received a missing value.`);

  if (typeof resolvedLeft === "number" && typeof resolvedRight === "number") {
    return Math.sign(resolvedLeft - resolvedRight);
  }
  if (typeof resolvedLeft === "string" && typeof resolvedRight === "string") {
    return resolvedLeft < resolvedRight ? -1 : resolvedLeft > resolvedRight ? 1 : 0;
  }
  throw evalError(`Helper "${helper}" expected comparable string or number values.`, state.options);
};

const stringifyForTemplate = (value: ResolvedValue, state: EvaluationState): string => {
  if (isUnavailable(value)) {
    throw evalError("Expression resolved to a missing value.", state.options);
  }
  rejectUnsafeValue(value, state);
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);

  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "" : encoded;
  } catch {
    throw evalError("Expression value could not be rendered as a string.", state.options);
  }
};

const encodeJson = (value: unknown, state: EvaluationState): string => {
  try {
    return JSON.stringify(value);
  } catch {
    throw evalError("Value could not be encoded as JSON.", state.options);
  }
};

const parseJson = (source: string, state: EvaluationState): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw evalError("Value could not be decoded as JSON.", state.options);
  }
};

const base64Encode = (source: string): string => {
  const bytes = new TextEncoder().encode(source);
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;

    output += BASE64_ALPHABET[(triple >> 18) & 63] ?? "";
    output += BASE64_ALPHABET[(triple >> 12) & 63] ?? "";
    output += index + 1 < bytes.length ? (BASE64_ALPHABET[(triple >> 6) & 63] ?? "") : "=";
    output += index + 2 < bytes.length ? (BASE64_ALPHABET[triple & 63] ?? "") : "=";
  }

  return output;
};

const base64Decode = (source: string, state: EvaluationState): string => {
  const normalized = source.trim();
  if (normalized.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(normalized)) {
    throw evalError("Value could not be decoded as base64.", state.options);
  }

  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 4) {
    const chars = normalized.slice(index, index + 4);
    const values = [...chars].map((char) => (char === "=" ? 0 : BASE64_LOOKUP.get(char)));
    if (values.some((value) => value === undefined)) {
      throw evalError("Value could not be decoded as base64.", state.options);
    }

    const triple =
      ((values[0] ?? 0) << 18) | ((values[1] ?? 0) << 12) | ((values[2] ?? 0) << 6) | (values[3] ?? 0);
    bytes.push((triple >> 16) & 255);
    if (chars[2] !== "=") bytes.push((triple >> 8) & 255);
    if (chars[3] !== "=") bytes.push(triple & 255);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw evalError("Value could not be decoded as base64.", state.options);
  }
};

const shellQuoteValue = (value: string): string => {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

const normalizePath = (path: string): string => {
  const absolute = path.startsWith("/");
  const parts: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push("..");
      }
      continue;
    }
    parts.push(part);
  }

  const joined = parts.join("/");
  if (absolute) return joined === "" ? "/" : `/${joined}`;
  return joined === "" ? "." : joined;
};

const pathJoin = (parts: ReadonlyArray<string>): string =>
  normalizePath(parts.filter((part) => part !== "").join("/"));

const pathDirname = (path: string): string => {
  const normalized = normalizePath(path);
  if (normalized === "/" || normalized === ".") return normalized;
  const withoutTrailing =
    normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
  const slash = withoutTrailing.lastIndexOf("/");
  if (slash === -1) return ".";
  if (slash === 0) return "/";
  return withoutTrailing.slice(0, slash);
};

const pathBasename = (path: string): string => {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const withoutTrailing =
    normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
  const slash = withoutTrailing.lastIndexOf("/");
  return slash === -1 ? withoutTrailing : withoutTrailing.slice(slash + 1);
};

const pathExtname = (path: string): string => {
  const base = pathBasename(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot);
};

const pathResolve = (parts: ReadonlyArray<string>): string => {
  let absolute = false;
  const selected: string[] = [];

  for (const part of parts) {
    if (part.startsWith("/")) {
      absolute = true;
      selected.length = 0;
    }
    selected.push(part);
  }

  const normalized = normalizePath(selected.join("/"));
  return absolute && !normalized.startsWith("/") ? `/${normalized}` : normalized;
};

const pathRelative = (from: string, to: string): string => {
  const fromNormalized = normalizePath(from);
  const toNormalized = normalizePath(to);
  const fromAbsolute = fromNormalized.startsWith("/");
  const toAbsolute = toNormalized.startsWith("/");
  if (fromAbsolute !== toAbsolute) return toNormalized;

  const fromParts = fromNormalized.replace(/^\//, "").split("/").filter(Boolean);
  const toParts = toNormalized.replace(/^\//, "").split("/").filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const relative = [...Array(fromParts.length - common).fill(".."), ...toParts.slice(common)].join("/");
  return relative === "" ? "." : relative;
};

const buildUrl = (value: Record<string, unknown>, state: EvaluationState): string => {
  const href = value.href;
  if (typeof href === "string") return href;

  const protocol = typeof value.protocol === "string" ? value.protocol.replace(/:$/, "") : undefined;
  const hostname = typeof value.hostname === "string" ? value.hostname : undefined;
  const host = typeof value.host === "string" ? value.host : undefined;
  const port =
    typeof value.port === "string" || typeof value.port === "number" ? String(value.port) : undefined;
  const pathname = typeof value.pathname === "string" ? value.pathname : "";
  const hash = typeof value.hash === "string" ? value.hash : "";
  let search = typeof value.search === "string" ? value.search : "";

  if (isRecordLike(value.query)) {
    const params = new URLSearchParams();
    for (const [key, queryValue] of safeObjectEntries("url.build", value.query, state)) {
      if (
        typeof queryValue === "string" ||
        typeof queryValue === "number" ||
        typeof queryValue === "boolean"
      ) {
        params.set(key, String(queryValue));
      }
    }
    const encoded = params.toString();
    if (encoded !== "") search = `?${encoded}`;
  }

  const authority =
    host ?? (hostname === undefined ? undefined : `${hostname}${port === undefined ? "" : `:${port}`}`);
  if (protocol !== undefined && authority !== undefined) {
    return `${protocol}://${authority}${pathname}${search}${hash}`;
  }
  if (authority !== undefined) return `//${authority}${pathname}${search}${hash}`;
  return `${pathname}${search}${hash}`;
};

const parseUrl = (source: string, state: EvaluationState): Record<string, unknown> => {
  try {
    const url = new URL(source);
    const query = Object.fromEntries(url.searchParams.entries());
    return {
      href: url.href,
      protocol: url.protocol,
      username: url.username,
      password: url.password,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      origin: url.origin,
      query,
    };
  } catch {
    throw evalError("Value could not be parsed as an absolute URL.", state.options);
  }
};

const parseSemver = (source: string, state: EvaluationState): SemverVersion => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(source.trim());
  if (match === null) {
    throw evalError("Semver helper expected a version in x.y.z form.", state.options);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

const compareSemverVersions = (left: SemverVersion, right: SemverVersion): number => {
  if (left.major !== right.major) return Math.sign(left.major - right.major);
  if (left.minor !== right.minor) return Math.sign(left.minor - right.minor);
  return Math.sign(left.patch - right.patch);
};

const satisfiesComparator = (version: SemverVersion, comparator: string, state: EvaluationState): boolean => {
  const match = /^(>=|<=|>|<|=)?\s*(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(comparator);
  if (match === null) {
    throw evalError("Semver range form is not supported by the sandboxed evaluator.", state.options);
  }
  const operator = match[1] ?? "=";
  const other = parseSemver(match[2] ?? "", state);
  const comparison = compareSemverVersions(version, other);
  if (operator === ">=") return comparison >= 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
};

const satisfiesCaret = (version: SemverVersion, range: SemverVersion): boolean => {
  const upper =
    range.major > 0
      ? { major: range.major + 1, minor: 0, patch: 0 }
      : range.minor > 0
        ? { major: 0, minor: range.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: range.patch + 1 };
  return compareSemverVersions(version, range) >= 0 && compareSemverVersions(version, upper) < 0;
};

const satisfiesTilde = (version: SemverVersion, range: SemverVersion): boolean => {
  const upper = { major: range.major, minor: range.minor + 1, patch: 0 };
  return compareSemverVersions(version, range) >= 0 && compareSemverVersions(version, upper) < 0;
};

const semverSatisfies = (versionSource: string, rangeSource: string, state: EvaluationState): boolean => {
  const version = parseSemver(versionSource, state);
  const range = rangeSource.trim();
  if (range.includes("||") || range.includes(" - ")) {
    throw evalError("Semver range form is not supported by the sandboxed evaluator.", state.options);
  }
  if (range.startsWith("^")) return satisfiesCaret(version, parseSemver(range.slice(1), state));
  if (range.startsWith("~")) return satisfiesTilde(version, parseSemver(range.slice(1), state));

  const comparators = range.split(/\s+/).filter(Boolean);
  if (comparators.length === 0) {
    throw evalError("Semver range must not be empty.", state.options);
  }
  return comparators.every((comparator) => satisfiesComparator(version, comparator, state));
};

const HELPERS: Record<string, Helper> = {
  default: (args, state) => {
    assertArgCount("default", args, state, 2);
    return isUnavailable(args[0]) ? requireResolved(args[1], state) : args[0];
  },
  required: (args, state) => {
    assertArgCount("required", args, state, 1, 2);
    const value = args[0];
    if (isUnavailable(value) || value === null || value === "") {
      const message =
        args.length === 2 ? asString("required", args[1], state) : "Required expression value is missing.";
      throw evalError(message, state.options);
    }
    return requireResolved(value, state);
  },
  eq: (args, state) => {
    assertArgCount("eq", args, state, 2);
    return deepEqual(requireResolved(args[0], state), requireResolved(args[1], state));
  },
  ne: (args, state) => {
    assertArgCount("ne", args, state, 2);
    return !deepEqual(requireResolved(args[0], state), requireResolved(args[1], state));
  },
  lt: (args, state) => {
    assertArgCount("lt", args, state, 2);
    return compareValues("lt", args[0], args[1], state) < 0;
  },
  gt: (args, state) => {
    assertArgCount("gt", args, state, 2);
    return compareValues("gt", args[0], args[1], state) > 0;
  },
  le: (args, state) => {
    assertArgCount("le", args, state, 2);
    return compareValues("le", args[0], args[1], state) <= 0;
  },
  ge: (args, state) => {
    assertArgCount("ge", args, state, 2);
    return compareValues("ge", args[0], args[1], state) >= 0;
  },
  and: (args, state) => {
    assertArgCount("and", args, state, 2);
    return isTruthy(requireResolved(args[0], state)) && isTruthy(requireResolved(args[1], state));
  },
  or: (args, state) => {
    assertArgCount("or", args, state, 2);
    return isTruthy(requireResolved(args[0], state)) || isTruthy(requireResolved(args[1], state));
  },
  not: (args, state) => {
    assertArgCount("not", args, state, 1);
    return !isTruthy(requireResolved(args[0], state));
  },
  contains: (args, state) => {
    assertArgCount("contains", args, state, 2);
    const haystack = requireResolved(args[0], state, 'Helper "contains" received a missing value.');
    const needle = requireResolved(args[1], state, 'Helper "contains" received a missing value.');
    if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
    if (Array.isArray(haystack)) return haystack.some((value) => deepEqual(value, needle));
    if (isRecordLike(haystack) && typeof needle === "string")
      return Object.prototype.propertyIsEnumerable.call(haystack, needle);
    throw evalError('Helper "contains" expected a string, array, or object collection.', state.options);
  },
  startsWith: (args, state) => {
    assertArgCount("startsWith", args, state, 2);
    return asString("startsWith", args[0], state).startsWith(asString("startsWith", args[1], state));
  },
  endsWith: (args, state) => {
    assertArgCount("endsWith", args, state, 2);
    return asString("endsWith", args[0], state).endsWith(asString("endsWith", args[1], state));
  },
  lower: (args, state) => {
    assertArgCount("lower", args, state, 1);
    return asString("lower", args[0], state).toLowerCase();
  },
  upper: (args, state) => {
    assertArgCount("upper", args, state, 1);
    return asString("upper", args[0], state).toUpperCase();
  },
  trim: (args, state) => {
    assertArgCount("trim", args, state, 1);
    return asString("trim", args[0], state).trim();
  },
  split: (args, state) => {
    assertArgCount("split", args, state, 2, 3);
    const limit = args.length === 3 ? asInteger("split", args[2], state) : undefined;
    return asString("split", args[0], state).split(asString("split", args[1], state), limit);
  },
  join: (args, state) => {
    assertArgCount("join", args, state, 2);
    return asArray("join", args[0], state)
      .map((value) => stringifyForTemplate(value, state))
      .join(asString("join", args[1], state));
  },
  replace: (args, state) => {
    assertArgCount("replace", args, state, 3);
    return asString("replace", args[0], state).replaceAll(
      asString("replace", args[1], state),
      asString("replace", args[2], state),
    );
  },
  regexMatch: (args, state) => {
    assertArgCount("regexMatch", args, state, 2, 3);
    try {
      return new RegExp(
        asString("regexMatch", args[1], state),
        optionalString(args[2], state, "regexMatch"),
      ).test(asString("regexMatch", args[0], state));
    } catch {
      throw evalError('Helper "regexMatch" received an invalid regular expression.', state.options);
    }
  },
  length: (args, state) => {
    assertArgCount("length", args, state, 1);
    const value = requireResolved(args[0], state, 'Helper "length" received a missing value.');
    if (typeof value === "string" || Array.isArray(value)) return value.length;
    if (isRecordLike(value)) return safeObjectEntries("length", value, state).length;
    throw evalError('Helper "length" expected a string, array, or object value.', state.options);
  },
  slice: (args, state) => {
    assertArgCount("slice", args, state, 2, 3);
    const value = requireResolved(args[0], state, 'Helper "slice" received a missing value.');
    const start = asInteger("slice", args[1], state);
    const end = args.length === 3 ? asInteger("slice", args[2], state) : undefined;
    if (typeof value === "string") return value.slice(start, end);
    if (Array.isArray(value)) return value.slice(start, end);
    throw evalError('Helper "slice" expected a string or array value.', state.options);
  },
  keys: (args, state) => {
    assertArgCount("keys", args, state, 1);
    return safeObjectEntries("keys", asObject("keys", args[0], state), state).map(([key]) => key);
  },
  values: (args, state) => {
    assertArgCount("values", args, state, 1);
    return safeObjectEntries("values", asObject("values", args[0], state), state).map(([, value]) => value);
  },
  entries: (args, state) => {
    assertArgCount("entries", args, state, 1);
    return safeObjectEntries("entries", asObject("entries", args[0], state), state).map(([key, value]) => [
      key,
      value,
    ]);
  },
  get: (args, state) => {
    assertArgCount("get", args, state, 2, 3);
    const fallback = args.length === 3 ? args[2] : MISSING;
    if (isUnavailable(args[0])) return fallback;
    const key = requireResolved(args[1], state, 'Helper "get" key resolved to a missing value.');
    const result =
      typeof key === "number"
        ? readIndex(args[0], key, state)
        : readOwnEnumerable(args[0], String(key), state);
    return isMissing(result) ? fallback : result;
  },
  merge: (args, state) => {
    if (args.length < 2)
      throw evalError('Helper "merge" received an unsupported number of arguments.', state.options);
    const merged: Record<string, unknown> = {};
    for (const value of args) {
      for (const [key, entryValue] of safeObjectEntries("merge", asObject("merge", value, state), state)) {
        merged[key] = entryValue;
      }
    }
    return merged;
  },
  range: (args, state) => {
    assertArgCount("range", args, state, 1, 3);
    const start = args.length === 1 ? 0 : asInteger("range", args[0], state);
    const end = args.length === 1 ? asInteger("range", args[0], state) : asInteger("range", args[1], state);
    const step = args.length === 3 ? asInteger("range", args[2], state) : start <= end ? 1 : -1;
    if (step === 0) throw evalError('Helper "range" step must not be zero.', state.options);
    const output: number[] = [];
    if (step > 0) {
      for (let value = start; value < end; value += step) output.push(value);
    } else {
      for (let value = start; value > end; value += step) output.push(value);
    }
    return output;
  },
  map: (args, state) => {
    assertArgCount("map", args, state, 2);
    const values = asArray("map", args[0], state);
    const helperName = asString("map", args[1], state);
    // Expressions have no lambda node, so map/filter accept a helper-name string.
    return values.map((value) => requireResolved(callHelperByName(helperName, [value], state), state));
  },
  filter: (args, state) => {
    assertArgCount("filter", args, state, 2);
    const values = asArray("filter", args[0], state);
    const helperName = asString("filter", args[1], state);
    return values.filter((value) =>
      isTruthy(requireResolved(callHelperByName(helperName, [value], state), state)),
    );
  },
  json: (args, state) => {
    assertArgCount("json", args, state, 1);
    return encodeJson(requireResolved(args[0], state), state);
  },
  fromJson: (args, state) => {
    assertArgCount("fromJson", args, state, 1);
    return parseJson(asString("fromJson", args[0], state), state);
  },
  b64encode: (args, state) => {
    assertArgCount("b64encode", args, state, 1);
    return base64Encode(asString("b64encode", args[0], state));
  },
  b64decode: (args, state) => {
    assertArgCount("b64decode", args, state, 1);
    return base64Decode(asString("b64decode", args[0], state), state);
  },
  shellQuote: (args, state) => {
    assertArgCount("shellQuote", args, state, 1);
    return shellQuoteValue(asString("shellQuote", args[0], state));
  },
  shellJoin: (args, state) => {
    assertArgCount("shellJoin", args, state, 1);
    return asArray("shellJoin", args[0], state)
      .map((value) => shellQuoteValue(stringifyForTemplate(value, state)))
      .join(" ");
  },
  "path.join": (args, state) => pathJoin(args.map((value) => asString("path.join", value, state))),
  "path.dirname": (args, state) => {
    assertArgCount("path.dirname", args, state, 1);
    return pathDirname(asString("path.dirname", args[0], state));
  },
  "path.basename": (args, state) => {
    assertArgCount("path.basename", args, state, 1);
    return pathBasename(asString("path.basename", args[0], state));
  },
  "path.extname": (args, state) => {
    assertArgCount("path.extname", args, state, 1);
    return pathExtname(asString("path.extname", args[0], state));
  },
  "path.relative": (args, state) => {
    assertArgCount("path.relative", args, state, 2);
    return pathRelative(asString("path.relative", args[0], state), asString("path.relative", args[1], state));
  },
  "path.resolve": (args, state) => pathResolve(args.map((value) => asString("path.resolve", value, state))),
  "url.build": (args, state) => {
    assertArgCount("url.build", args, state, 1);
    return buildUrl(asObject("url.build", args[0], state), state);
  },
  "url.parse": (args, state) => {
    assertArgCount("url.parse", args, state, 1);
    return parseUrl(asString("url.parse", args[0], state), state);
  },
  "semver.satisfies": (args, state) => {
    assertArgCount("semver.satisfies", args, state, 2);
    return semverSatisfies(
      asString("semver.satisfies", args[0], state),
      asString("semver.satisfies", args[1], state),
      state,
    );
  },
  "semver.compare": (args, state) => {
    assertArgCount("semver.compare", args, state, 2);
    return compareSemverVersions(
      parseSemver(asString("semver.compare", args[0], state), state),
      parseSemver(asString("semver.compare", args[1], state), state),
    );
  },
};

const evaluateExpressionSync = (
  node: ExpressionNode,
  context: ExpressionContext,
  options: EvaluateExpressionOptions = {},
): unknown => requireResolved(resolveNode(node, { context, options }), { context, options });

const evaluateTemplateSync = (
  template: ExpressionTemplate,
  context: ExpressionContext,
  options: EvaluateExpressionOptions = {},
): unknown => {
  const state = { context, options };
  const onlySegment = template.segments[0];
  if (template.whole && template.segments.length === 1 && onlySegment?.kind === "InterpolationSegment") {
    return requireResolved(resolveNode(onlySegment.expression, state), state);
  }

  let output = "";
  let trimNextLiteral = false;
  for (const segment of template.segments) {
    if (segment.kind === "LiteralSegment") {
      const text = trimNextLiteral ? segment.text.replace(/^\s+/, "") : segment.text;
      output += text;
      trimNextLiteral = false;
      continue;
    }

    if (segment.kind === "InterpolationSegment") {
      trimNextLiteral = false;
      if (segment.trimLeft) output = output.replace(/\s+$/, "");
      output += stringifyForTemplate(resolveNode(segment.expression, state), state);
      if (segment.trimRight) trimNextLiteral = true;
      continue;
    }

    if (segment.kind === "ShellParamSegment") {
      trimNextLiteral = false;
      output += renderShellParam(segment, state);
      continue;
    }

    if (segment.kind === "SecretRefSegment") {
      trimNextLiteral = false;
      output += renderSecretRef(segment.name, state);
    }
  }
  return output;
};

const renderShellParam = (segment: ShellParamSegment, state: EvaluationState): string => {
  const value = readOwnEnumerable(state.context.env ?? {}, segment.name, state);
  const isSet = !isUnavailable(value);
  const stringValue = isSet ? asString("shell parameter", value, state) : "";

  if (segment.operator === "plain") return isSet ? stringValue : "";
  if (segment.operator === "default-empty")
    return !isSet || stringValue === "" ? (segment.word ?? "") : stringValue;
  if (segment.operator === "default-unset") return isSet ? stringValue : (segment.word ?? "");
  if (segment.operator === "alt") return isSet && stringValue !== "" ? (segment.word ?? "") : "";

  if (!isSet || stringValue === "") {
    throw evalError(`Required environment variable "${segment.name}" is missing or empty.`, state.options);
  }
  return stringValue;
};

const renderSecretRef = (name: string, state: EvaluationState): string => {
  const value = readOwnEnumerable(state.context.secrets ?? {}, name, state);
  if (isUnavailable(value)) {
    throw evalError(`Secret "${name}" is not available in the expression context.`, state.options);
  }
  return asString("secret", value, state);
};

export const evaluateExpressionEither = (
  node: ExpressionNode,
  context: ExpressionContext,
  options: EvaluateExpressionOptions = {},
): Either.Either<unknown, LandofileExpressionEvaluationError> => {
  try {
    return Either.right(evaluateExpressionSync(node, context, options));
  } catch (cause) {
    return Either.left(wrapUnknownEvaluationError(options, cause));
  }
};

export const evaluateExpression = (
  node: ExpressionNode,
  context: ExpressionContext,
  options: EvaluateExpressionOptions = {},
): Effect.Effect<unknown, LandofileExpressionEvaluationError> =>
  Effect.try({
    try: () => evaluateExpressionSync(node, context, options),
    catch: (cause) => wrapUnknownEvaluationError(options, cause),
  });

export const evaluateTemplateEither = (
  template: ExpressionTemplate,
  context: ExpressionContext,
  options: EvaluateExpressionOptions = {},
): Either.Either<unknown, LandofileExpressionEvaluationError> => {
  try {
    return Either.right(evaluateTemplateSync(template, context, options));
  } catch (cause) {
    return Either.left(wrapUnknownEvaluationError(options, cause));
  }
};

export const evaluateTemplate = (
  template: ExpressionTemplate,
  context: ExpressionContext,
  options: EvaluateExpressionOptions = {},
): Effect.Effect<unknown, LandofileExpressionEvaluationError> =>
  Effect.try({
    try: () => evaluateTemplateSync(template, context, options),
    catch: (cause) => wrapUnknownEvaluationError(options, cause),
  });
