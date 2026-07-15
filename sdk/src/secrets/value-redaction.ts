import { REDACTED } from "./redactor.ts";

export const redactValueWith = (
  redactString: (text: string) => string,
  isSecretKey: (key: string) => boolean,
  value: unknown,
): unknown => {
  const stack = new WeakSet<object>();
  const memo = new WeakMap<object, unknown>();

  const visit = (current: unknown): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === "string") return redactString(current);
    if (typeof current !== "object") return current;
    const memoHit = memo.get(current);
    if (memoHit !== undefined) return memoHit;
    if (stack.has(current)) return "[circular]";
    stack.add(current);

    let result: unknown;
    if (Array.isArray(current)) {
      result = current.map(visit);
    } else if (current instanceof Error) {
      result = { name: current.name, message: redactString(current.message) };
    } else {
      let keys: string[];
      try {
        keys = Object.keys(current);
      } catch {
        result = REDACTED;
        stack.delete(current);
        memo.set(current, result);
        return result;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (isSecretKey(key)) {
          output[key] = REDACTED;
          continue;
        }
        try {
          output[key] = visit(Reflect.get(current, key));
        } catch {
          output[key] = REDACTED;
        }
      }
      result = output;
    }
    stack.delete(current);
    memo.set(current, result);
    return result;
  };

  return visit(value);
};
