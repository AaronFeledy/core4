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
}

/** Below a scope, a position the schema cannot describe redacts every key and string. */
const OPAQUE_SCOPE: ValueRedactionScope = {
  keyIsDeclared: () => false,
  child: () => OPAQUE_SCOPE,
  element: () => OPAQUE_SCOPE,
  stringIsExempt: () => false,
};

export const redactValueWith = (
  redactString: (text: string) => string,
  isSecretKey: (key: string) => boolean,
  value: unknown,
  scope?: ValueRedactionScope,
): unknown => {
  const stack = new WeakSet<object>();
  const memo = new WeakMap<object, Map<ValueRedactionScope | undefined, unknown>>();

  const visit = (current: unknown, currentScope: ValueRedactionScope | undefined): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === "string")
      return currentScope?.stringIsExempt(current) === true ? current : redactString(current);
    if (typeof current !== "object") return current;
    const memoHit = memo.get(current);
    if (memoHit?.has(currentScope) === true) return memoHit.get(currentScope);
    if (stack.has(current)) return "[circular]";
    stack.add(current);

    let result: unknown;
    if (Array.isArray(current)) {
      const length = current.length;
      result = current.map((item, index) =>
        visit(item, currentScope && (currentScope.element(index, length) ?? OPAQUE_SCOPE)),
      );
    } else if (current instanceof Error) {
      result = { name: current.name, message: redactString(current.message) };
    } else {
      let keys: string[];
      try {
        keys = Object.keys(current);
      } catch {
        result = REDACTED;
        stack.delete(current);
        memo.set(current, new Map([[currentScope, result]]));
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
        if (isSecretKey(key)) {
          // A boolean describes whether a capability exists; it cannot carry
          // credential material. Keep its type in structured command output.
          try {
            const field = Reflect.get(current, key);
            if (typeof field === "boolean") output[outputKey] = field;
            // A schema-fixed literal cannot carry user data either.
            else if (typeof field === "string" && childScope?.stringIsExempt(field) === true)
              output[outputKey] = field;
            // A published development default is public only as authored bytes;
            // the ordinary string path still masks it when it was registered or
            // resolved from a secret store.
            else if (typeof field === "string" && isPublicDefaultCredential(field))
              output[outputKey] = visit(field, childScope);
            else output[outputKey] = REDACTED;
          } catch {
            output[outputKey] = REDACTED;
          }
          continue;
        }
        try {
          output[outputKey] = visit(Reflect.get(current, key), childScope);
        } catch {
          output[outputKey] = REDACTED;
        }
      }
      result = output;
    }
    stack.delete(current);
    let cached = memo.get(current);
    if (cached === undefined) {
      cached = new Map();
      memo.set(current, cached);
    }
    cached.set(currentScope, result);
    return result;
  };

  return visit(value, scope);
};
