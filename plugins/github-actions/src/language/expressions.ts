import { Evaluator, Lexer, Parser, data, wellKnownFunctions } from "@actions/expressions";
import {
  Binary,
  type ContextAccess,
  type Expr,
  FunctionCall,
  Grouping,
  IndexAccess,
  Literal,
  Logical,
  Unary,
} from "@actions/expressions/ast";
import type { FunctionDefinition } from "@actions/expressions/funcs/info";
import { Effect } from "effect";
import {
  ExpressionLimit,
  LanguageError,
  type LanguageSource,
  UnavailableContext,
  languageError,
} from "./errors.ts";
export { UnavailableContext } from "./errors.ts";

export interface ExpressionLimits {
  sourceBytes: number;
  tokens: number;
  astNodes: number;
  astDepth: number;
  work: number;
  valueBytes: number;
  valueNodes: number;
  valueDepth: number;
}
export const expressionLimits: Readonly<ExpressionLimits> = {
  sourceBytes: 16 * 1024,
  tokens: 4096,
  astNodes: 4096,
  astDepth: 50,
  work: 100_000,
  valueBytes: 256 * 1024,
  valueNodes: 50_000,
  valueDepth: 64,
};
export interface ExpressionOptions {
  readonly contextNames?: readonly string[];
  readonly functions?: ReadonlyMap<string, FunctionDefinition>;
  readonly limits?: Partial<ExpressionLimits>;
  readonly source?: LanguageSource;
}
const resolveLimits = (options: ExpressionOptions): ExpressionLimits => {
  const result = { ...expressionLimits, ...options.limits };
  for (const key of Object.keys(result) as (keyof ExpressionLimits)[]) {
    const n = result[key];
    if (!Number.isSafeInteger(n) || n <= 0 || n > expressionLimits[key]) throw new ExpressionLimit();
  }
  return result;
};
export const boundedUtf8Size = (text: string, remaining: number): number => {
  if (text.length > remaining) throw new ExpressionLimit();
  const size = new TextEncoder().encode(text).length;
  if (size > remaining) throw new ExpressionLimit();
  return size;
};
const utf8Size = boundedUtf8Size;
const children = (node: Expr): readonly Expr[] =>
  node instanceof Binary
    ? [node.left, node.right]
    : node instanceof Logical || node instanceof FunctionCall
      ? node.args
      : node instanceof Unary
        ? [node.expr]
        : node instanceof Grouping
          ? [node.group]
          : node instanceof IndexAccess
            ? [node.expr, node.index]
            : [];
export const expressionFunctionNames = (ast: Expr): readonly string[] => {
  const names = new Set<string>();
  const pending = [ast];
  while (pending.length) {
    const n = pending.pop();
    if (n === undefined) break;
    if (n instanceof FunctionCall) names.add(n.functionName.lexeme.toLowerCase());
    pending.push(...children(n));
  }
  return [...names];
};
const extensions = (options: ExpressionOptions) => {
  const result = new Map<string, FunctionDefinition>();
  if ((options.functions?.size ?? 0) > 5) throw new ExpressionLimit();
  for (const [name, fn] of options.functions ?? []) {
    const key = name.toLowerCase();
    // Host IO functions are never implicit; only these explicit, synchronous pure inputs are accepted.
    if (!["always", "success", "failure", "cancelled", "hashfiles"].includes(key))
      throw new ExpressionLimit();
    result.set(key, fn);
  }
  return result;
};
const parseExpression = (text: string, options: ExpressionOptions, limits: ExpressionLimits): Expr => {
  utf8Size(text, limits.sourceBytes);
  if ((options.contextNames?.length ?? 0) > 64) throw new ExpressionLimit();
  let contextBytes = 0;
  for (const name of options.contextNames ?? [])
    contextBytes += utf8Size(name, limits.sourceBytes - contextBytes);
  const { tokens } = new Lexer(text).lex();
  if (tokens.length > limits.tokens) throw new ExpressionLimit();
  const parsed = new Parser(
    tokens,
    [...(options.contextNames ?? [])],
    [...extensions(options).values()],
  ).parse();
  const first = tokens[0];
  if (first === undefined) throw new ExpressionLimit();
  const ast = parsed ?? new Literal(new data.Null(), first);
  let nodes = 0;
  const pending = [{ node: ast, depth: 1 }];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) break;
    if (++nodes > limits.astNodes || current.depth > limits.astDepth) throw new ExpressionLimit();
    for (const node of children(current.node)) pending.push({ node, depth: current.depth + 1 });
  }
  return ast;
};
const failure = (
  error: unknown,
  source: LanguageSource,
  code: "expression-syntax" | "expression-evaluation",
) =>
  error instanceof LanguageError
    ? error
    : languageError(
        error instanceof ExpressionLimit
          ? "expression-limit"
          : error instanceof UnavailableContext
            ? "context-unavailable"
            : code,
        source,
      );
export const validateExpression = (text: string, source: LanguageSource, options: ExpressionOptions = {}) =>
  Effect.try({
    try: () => parseExpression(text, options, resolveLimits(options)),
    catch: (error) => failure(error, source, "expression-syntax"),
  });

// Semantic enumeration of a partial object must wait for its missing fields.
// Only the budget walker may inspect its known pairs without forcing those fields.
const partialKnownPairs = new WeakMap<data.Dictionary, () => ReturnType<data.Dictionary["pairs"]>>();
export class PartialDictionary extends data.Dictionary {
  constructor(
    value: data.Dictionary,
    private readonly missing: readonly string[],
  ) {
    super(...value.pairs());
    partialKnownPairs.set(this, () => super.pairs());
  }
  override get(name: string): data.ExpressionData | undefined {
    const value = super.get(name);
    if (value === undefined && this.missing.includes(name.toLowerCase())) throw new UnavailableContext();
    return value;
  }
  override pairs(): ReturnType<data.Dictionary["pairs"]> {
    throw new UnavailableContext();
  }
  override values(): data.ExpressionData[] {
    throw new UnavailableContext();
  }
}

interface Measure {
  nodes: number;
  bytes: number;
  depth: number;
}
// Counts occurrences, not identities: a shared object is serialized repeatedly by toJSON.
export const measureExpressionValue = (value: data.ExpressionData, limits: ExpressionLimits): Measure => {
  const pending = [{ value, depth: 1, ancestors: new Set<data.ExpressionData>() }];
  let nodes = 0;
  let bytes = 0;
  let depth = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) break;
    if (
      ++nodes > limits.valueNodes ||
      current.depth > limits.valueDepth ||
      current.ancestors.has(current.value)
    )
      throw new ExpressionLimit();
    depth = Math.max(depth, current.depth);
    const v = current.value;
    if (v instanceof data.StringData) bytes += utf8Size(v.value, limits.valueBytes - bytes);
    else if (v instanceof data.Dictionary || v instanceof data.Array) {
      const ancestors = new Set(current.ancestors);
      ancestors.add(v);
      let pairs: ReturnType<data.Dictionary["pairs"]>;
      if (v instanceof data.Dictionary) {
        const knownPairs = partialKnownPairs.get(v);
        if (knownPairs !== undefined) pairs = knownPairs();
        else {
          if (v.values().length + nodes + pending.length > limits.valueNodes) throw new ExpressionLimit();
          pairs = v.pairs();
        }
      } else {
        const values = v.values();
        if (values.length + nodes + pending.length > limits.valueNodes) throw new ExpressionLimit();
        pairs = values.map((value) => ({ key: "", value }));
      }
      if (nodes + pending.length + pairs.length > limits.valueNodes) throw new ExpressionLimit();
      for (const pair of pairs) {
        bytes += utf8Size(pair.key, limits.valueBytes - bytes);
        pending.push({ value: pair.value, depth: current.depth + 1, ancestors });
      }
    } else bytes += 8;
    if (bytes > limits.valueBytes) throw new ExpressionLimit();
  }
  return { nodes, bytes, depth };
};
const scanJson = (text: string, limits: ExpressionLimits) => {
  let depth = 0;
  let nodes = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      nodes++;
    } else if (char === "[" || char === "{") {
      depth++;
      nodes++;
    } else if (char === "]" || char === "}") depth--;
    else if (char !== undefined && /[0-9tfn-]/.test(char) && (i === 0 || /[\s[:,]/.test(text[i - 1] ?? "")))
      nodes++;
    if (depth > limits.valueDepth || nodes > limits.valueNodes) throw new ExpressionLimit();
  }
};
const boundedFunctions = (options: ExpressionOptions, limits: ExpressionLimits) => {
  const result = extensions(options);
  for (const name of ["format", "join", "tojson", "fromjson"]) {
    const original = wellKnownFunctions[name];
    if (original === undefined) throw new ExpressionLimit();
    result.set(name, {
      ...original,
      call: (...args) => {
        for (const arg of args) measureExpressionValue(arg, limits);
        let bound = 0;
        if (name === "format") {
          const format = args[0]?.coerceString() ?? "";
          let max = 0;
          for (const arg of args.slice(1))
            max = Math.max(max, new TextEncoder().encode(arg.coerceString()).length);
          // Every placeholder consumes at least three characters; this bound also covers escapes/literals.
          bound = new TextEncoder().encode(format).length + Math.floor(format.length / 3) * max;
        } else if (name === "join") {
          const first = args[0];
          const separator = args[1]?.primitive ? args[1].coerceString() : ",";
          const values = first instanceof data.Array ? first.values() : first === undefined ? [] : [first];
          bound =
            values.reduce((n, value) => n + new TextEncoder().encode(value.coerceString()).length, 0) +
            Math.max(0, values.length - 1) * new TextEncoder().encode(separator).length;
        } else if (name === "tojson") {
          const value = args[0];
          if (value === undefined) throw new ExpressionLimit();
          const m = measureExpressionValue(value, limits);
          bound = m.bytes * 6 + m.nodes * (2 * m.depth + 8);
        } else {
          const text = args[0]?.coerceString() ?? "";
          bound = new TextEncoder().encode(text).length;
          scanJson(text, limits);
        }
        if (bound > limits.valueBytes) throw new ExpressionLimit();
        return original.call(...args);
      },
    });
  }
  return result;
};
export interface ExpressionBudget {
  spent: number;
  contexts: WeakSet<data.Dictionary>;
}
export const createExpressionBudget = (): ExpressionBudget => ({ spent: 0, contexts: new WeakSet() });
class BoundedEvaluator extends Evaluator {
  private unavailable = false;
  private exhausted = false;
  constructor(
    ast: Expr,
    context: data.Dictionary,
    functions: Map<string, FunctionDefinition>,
    private readonly budget: ExpressionLimits,
    private readonly tracker: ExpressionBudget,
  ) {
    super(ast, context, functions);
  }
  protected override eval(node: Expr): data.ExpressionData {
    try {
      if (++this.tracker.spent > this.budget.work) throw new ExpressionLimit();
      const result = super.eval(node);
      const measured = measureExpressionValue(result, this.budget);
      this.tracker.spent += measured.nodes + Math.ceil(measured.bytes / 64);
      if (this.tracker.spent > this.budget.work) throw new ExpressionLimit();
      return result;
    } catch (error) {
      // Upstream index access wraps nested errors. Keep only our fixed sentinel state.
      this.unavailable ||= error instanceof UnavailableContext;
      this.exhausted ||= error instanceof ExpressionLimit;
      if (this.exhausted) throw new ExpressionLimit();
      if (this.unavailable) throw new UnavailableContext();
      throw error;
    }
  }
  override visitContextAccess(node: ContextAccess): data.ExpressionData {
    return super.visitContextAccess(node) ?? new data.Null();
  }
}
export const evaluateExpressionWithBudget = Effect.fnUntraced(function* (
  text: string,
  context: data.Dictionary,
  source: LanguageSource,
  options: ExpressionOptions,
  budget: ExpressionBudget,
) {
  yield* Effect.try({
    try: () => {
      const limits = resolveLimits(options);
      if (!budget.contexts.has(context)) {
        const measured = measureExpressionValue(context, limits);
        budget.spent += measured.nodes + Math.ceil(measured.bytes / 64);
        budget.contexts.add(context);
      }
    },
    catch: (error) => failure(error, source, "expression-evaluation"),
  });
  const settings = { ...options, contextNames: options.contextNames ?? context.pairs().map((p) => p.key) };
  const ast = yield* validateExpression(text, source, settings);
  return yield* Effect.try({
    try: () => {
      const limits = resolveLimits(settings);
      return new BoundedEvaluator(
        ast,
        context,
        boundedFunctions(settings, limits),
        limits,
        budget,
      ).evaluate();
    },
    catch: (error) => failure(error, source, "expression-evaluation"),
  });
});

export const evaluateExpression = (
  text: string,
  context: data.Dictionary,
  source: LanguageSource,
  options: ExpressionOptions = {},
) => evaluateExpressionWithBudget(text, context, source, options, createExpressionBudget());

/** Admit plain JSON data without invoking getters; preserve repeated object identity. */
export const expressionDataFromUnknownSync = (
  input: unknown,
  options: ExpressionOptions = {},
): data.ExpressionData => {
  const limits = resolveLimits(options);
  let nodes = 0;
  let bytes = 0;
  const pending = [{ value: input, depth: 1, ancestors: new Set<object>() }];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) break;
    if (++nodes > limits.valueNodes || current.depth > limits.valueDepth) throw new ExpressionLimit();
    const value = current.value;
    if (typeof value === "string") bytes += utf8Size(value, limits.valueBytes - bytes);
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new ExpressionLimit();
      bytes += 8;
    } else if (value === null || typeof value === "boolean") bytes += 8;
    else if (typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      const array = Array.isArray(value);
      if (
        (!array && proto !== Object.prototype && proto !== null) ||
        (array && proto !== Array.prototype) ||
        current.ancestors.has(value)
      )
        throw new ExpressionLimit();
      if (array && value.length > limits.valueNodes) throw new ExpressionLimit();
      const keys = Reflect.ownKeys(value);
      if (keys.length > limits.valueNodes) throw new ExpressionLimit();
      const ancestors = new Set(current.ancestors);
      ancestors.add(value);
      if (array && keys.length !== value.length + 1) throw new ExpressionLimit();
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new ExpressionLimit();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
          throw new ExpressionLimit();
        bytes += utf8Size(key, limits.valueBytes - bytes);
        pending.push({ value: descriptor.value, depth: current.depth + 1, ancestors });
      }
    } else throw new ExpressionLimit();
    if (bytes > limits.valueBytes || nodes + pending.length > limits.valueNodes) throw new ExpressionLimit();
  }
  const seen = new Map<object, data.ExpressionData>();
  const convert = (value: unknown): data.ExpressionData => {
    if (value === null) return new data.Null();
    if (typeof value === "string") return new data.StringData(value);
    if (typeof value === "number") return new data.NumberData(value);
    if (typeof value === "boolean") return new data.BooleanData(value);
    if (typeof value !== "object") throw new ExpressionLimit();
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    if (Array.isArray(value)) {
      const result = new data.Array();
      seen.set(value, result);
      for (const item of value) result.add(convert(item));
      return result;
    }
    const result = new data.Dictionary();
    seen.set(value, result);
    for (const key of Object.keys(value))
      result.add(key, convert(Object.getOwnPropertyDescriptor(value, key)?.value));
    return result;
  };
  return convert(input);
};
export const expressionDataFromUnknown = (
  input: unknown,
  source: LanguageSource,
  options: ExpressionOptions = {},
) =>
  Effect.try({
    try: () => expressionDataFromUnknownSync(input, options),
    catch: () => languageError("expression-limit", source),
  });
