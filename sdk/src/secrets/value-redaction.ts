import { isPublicDefaultCredential } from "./public-default-credentials.ts";
import { REDACTED } from "./redactor.ts";

/**
 * Structural knowledge about a runtime value that a schema-backed caller can
 * supply to keep values the schema fixes to finite literals. A scope is
 * value-driven: `child` receives the object being walked so
 * a union can narrow on that value's own discriminant properties.
 */
export interface ValueRedactionScope {
  /** True when the schema declares `key`; any other key is redacted like a value. */
  readonly keyIsDeclared: (key: string, value: object) => boolean;
  readonly child: (key: string, value: object) => ValueRedactionScope | undefined;
  readonly element: (index: number, length: number) => ValueRedactionScope | undefined;
  readonly stringIsExempt: (value: string) => boolean;
  /**
   * True when every live schema candidate at this position that accepts the
   * value is a concrete number schema or a matching numeric literal. A number
   * is data under a secret-named key unless the schema types this position as
   * a number; an Unknown/Any/opaque candidate never proves that.
   */
  readonly numberIsExempt?: ((value: number) => boolean) | undefined;
  /**
   * True when every live schema candidate for this object is a secret
   * descriptor: a published shape that carries references, never credential
   * bytes. Only such a value keeps its own structure under a secret-named key.
   */
  readonly isSecretDescriptor?: ((value: object) => boolean) | undefined;
}

/** Below a scope, a position the schema cannot describe redacts every key and string. */
const OPAQUE_SCOPE: ValueRedactionScope = {
  keyIsDeclared: () => false,
  child: () => OPAQUE_SCOPE,
  element: () => OPAQUE_SCOPE,
  stringIsExempt: () => false,
};

/**
 * `Array.isArray` and `instanceof` run proxy traps, and a revoked proxy throws.
 * Exotic input must fail closed instead of throwing, so an unreadable value is
 * reported as `undefined` and classified as `[redacted]`.
 */
const safeIsArray = (value: object): boolean | undefined => {
  try {
    return Array.isArray(value);
  } catch {
    return undefined;
  }
};

const safeIsError = (value: object): boolean => {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
};

/** What the secret-named-field rule does with one value. */
export type SecretFieldRedaction =
  /** Keep the value's own shape and apply the ordinary rules. */
  | { readonly kind: "ordinary" }
  /** Keep the value's own shape and apply this rule at every position. */
  | { readonly kind: "secret" }
  /** Replace the whole value with exact text. */
  | { readonly kind: "replace"; readonly text: string };

/**
 * The one secret-named-field rule. Both the value walker and the MCP bounded
 * serializer classify a field through this function, so a structured result and
 * its machine envelope mask the same bytes.
 *
 * A value the schema fixes to a finite literal describes the schema, not the
 * user, so it survives. A number survives only when the schema types this
 * position as a number, because masking it would turn a typed number into a
 * string and break schema decoding; without that proof it is data. A published
 * development default is public only as authored bytes, so it takes the
 * ordinary string path. Everything else under a secret-named key is masked
 * unless its shape is proven harmless: a secret descriptor
 * (`{_tag: "SecretRef", ...}`) or an array/object whose every own key the schema
 * declares or indexes.
 */
export const redactSecretField = (
  redactString: (text: string) => string,
  value: unknown,
  scope?: ValueRedactionScope,
): SecretFieldRedaction => {
  if (value === null || value === undefined || typeof value === "boolean") return { kind: "ordinary" };
  if (typeof value === "string") {
    if (scope?.stringIsExempt(value) === true) return { kind: "ordinary" };
    if (isPublicDefaultCredential(value)) return { kind: "replace", text: redactString(value) };
    return { kind: "replace", text: REDACTED };
  }
  if (typeof value === "number")
    return scope?.numberIsExempt?.(value) === true
      ? { kind: "ordinary" }
      : { kind: "replace", text: REDACTED };
  if (typeof value !== "object") return { kind: "replace", text: REDACTED };
  // A revoked proxy throws from `Array.isArray` and `instanceof`; fail closed.
  const array = safeIsArray(value);
  if (array === undefined) return { kind: "replace", text: REDACTED };
  // Error loses the structured shape it would only carry as free text.
  if (safeIsError(value)) return { kind: "replace", text: REDACTED };
  if (array) return { kind: "secret" };
  if (scope?.isSecretDescriptor?.(value) === true) return { kind: "ordinary" };
  // A missing or opaque scope never proves a key name harmless.
  if (scope === undefined || scope === OPAQUE_SCOPE) return { kind: "replace", text: REDACTED };
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return { kind: "replace", text: REDACTED };
  }
  for (const key of keys) {
    try {
      if (!scope.keyIsDeclared(key, value) && scope.child(key, value) === undefined)
        return { kind: "replace", text: REDACTED };
    } catch {
      return { kind: "replace", text: REDACTED };
    }
  }
  return { kind: "secret" };
};

/**
 * Which rule a position is walked under. A secret-keyed field keeps only the
 * structure `redactSecretField` proved harmless, so the same object visited
 * under a public key and then a secret key cannot reuse the public result.
 */
type TraversalMode = "ordinary" | "secret";

/** Read one string part of an exotic value; a throwing or non-string read fails closed. */
const readStringPart = (read: () => unknown): string => {
  try {
    const part = read();
    return typeof part === "string" ? part : REDACTED;
  } catch {
    return REDACTED;
  }
};

export const redactValueWith = (
  redactString: (text: string) => string,
  isSecretKey: (key: string) => boolean,
  value: unknown,
  scope?: ValueRedactionScope,
): unknown => {
  const stack = new WeakSet<object>();
  const memo = new WeakMap<object, Map<ValueRedactionScope | undefined, Map<TraversalMode, unknown>>>();

  const visit = (
    current: unknown,
    currentScope: ValueRedactionScope | undefined,
    mode: TraversalMode,
  ): unknown => {
    if (mode === "ordinary") return walk(current, currentScope, mode);
    const decision = redactSecretField(redactString, current, currentScope);
    if (decision.kind === "replace") return decision.text;
    return walk(current, currentScope, decision.kind);
  };

  const walk = (
    current: unknown,
    currentScope: ValueRedactionScope | undefined,
    mode: TraversalMode,
  ): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === "string")
      return currentScope?.stringIsExempt(current) === true ? current : redactString(current);
    if (typeof current !== "object") return current;
    // A revoked proxy throws from `Array.isArray` and `instanceof`, and a proxy
    // may throw from a prototype trap; exotic input fails closed.
    let items: readonly unknown[] | undefined;
    let error: Error | undefined;
    try {
      if (Array.isArray(current)) items = current;
      else if (current instanceof Error) error = current;
    } catch {
      return REDACTED;
    }
    const cached = memo.get(current)?.get(currentScope);
    if (cached?.has(mode) === true) return cached.get(mode);
    if (stack.has(current)) return "[circular]";
    stack.add(current);

    let result: unknown;
    if (items !== undefined) {
      const length = items.length;
      const visited: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        // An element getter may throw; one exotic element fails closed without
        // taking the whole detail (or the redactor) down with it.
        let item: unknown;
        try {
          item = items[index];
        } catch {
          item = REDACTED;
        }
        visited.push(
          visit(item, currentScope && (currentScope.element(index, length) ?? OPAQUE_SCOPE), mode),
        );
      }
      result = visited;
    } else if (error !== undefined) {
      result = {
        name: readStringPart(() => error.name),
        message: redactString(readStringPart(() => error.message)),
      };
    } else {
      let keys: string[];
      try {
        keys = Object.keys(current);
      } catch {
        result = REDACTED;
        stack.delete(current);
        memo.set(current, new Map([[currentScope, new Map([[mode, result]])]]));
        return result;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        let childScope: ValueRedactionScope | undefined;
        let outputKey = key;
        if (currentScope !== undefined) {
          try {
            childScope = currentScope.child(key, current) ?? OPAQUE_SCOPE;
            if (!currentScope.keyIsDeclared(key, current)) outputKey = redactString(key);
          } catch {
            childScope = OPAQUE_SCOPE;
            outputKey = redactString(key);
          }
        }
        try {
          const field = Reflect.get(current, key);
          const fieldMode = mode === "secret" || isSecretKey(key) ? "secret" : "ordinary";
          output[outputKey] = visit(field, childScope, fieldMode);
        } catch {
          output[outputKey] = REDACTED;
        }
      }
      result = output;
    }
    stack.delete(current);
    let byScope = memo.get(current);
    if (byScope === undefined) {
      byScope = new Map();
      memo.set(current, byScope);
    }
    let byMode = byScope.get(currentScope);
    if (byMode === undefined) {
      byMode = new Map();
      byScope.set(currentScope, byMode);
    }
    byMode.set(mode, result);
    return result;
  };

  return visit(value, scope, "ordinary");
};
