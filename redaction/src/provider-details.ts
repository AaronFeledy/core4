import { types } from "node:util";
import type { Redactor } from "@lando/sdk/secrets";

const masked = "[redacted]";
const overflow = Symbol("provider details budget");

// Provider diagnostics accept arbitrary caller values. Never let their hooks run at
// the canonical redactor boundary. Object.keys allocates its intrinsic key list;
// the limits below bound projection work/output, not that initial allocation.
const project = (input: unknown, redactor?: Redactor): unknown => {
  let visits = 0;
  let units = 0;
  const ancestors = new WeakSet<object>();
  const charge = (value: string): string => {
    const bounded = value.length > 16384 ? masked : value;
    units += bounded.length;
    if (units > 65536) throw overflow;
    return bounded;
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (++visits > 2048) throw overflow;
    if (depth > 16) return masked;
    if (typeof value === "string") return charge(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : masked;
    if (typeof value !== "object") return masked;
    // Must precede even Array.isArray: revoked proxies throw there.
    if (types.isProxy(value)) return masked;
    if (ancestors.has(value)) return masked;
    ancestors.add(value);
    try {
      const nativeError = types.isNativeError(value);
      const array = Array.isArray(value);
      if (!nativeError && !array) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) return masked;
      }
      const keys = nativeError ? ["name", "message"] : Object.keys(value);
      if (keys.length > 256) return masked;
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (typeof length !== "number" || length > 256) return masked;
        const output: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          output[index] = descriptor && "value" in descriptor ? walk(descriptor.value, depth + 1) : masked;
        }
        return output;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (key === "toJSON" || key === "stack" || key === "cause") continue;
        if (key.length > 16384) continue;
        charge(key);
        if (redactor) {
          const safeKey = redactor.redactString(key);
          if (typeof safeKey !== "string") throw overflow;
          if (safeKey !== key) continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) continue;
        output[key] = "value" in descriptor ? walk(descriptor.value, depth + 1) : masked;
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  };
  return walk(input, 0);
};

export const redactProviderDetails = (value: unknown, redactor: Redactor): unknown => {
  try {
    const safe = project(value, redactor);
    // Re-project after canonical redaction to bound expansions and fail closed on
    // unexpected redactor output. Repeated references are charged per occurrence.
    return project(redactor.redactValue(safe), redactor);
  } catch {
    return masked;
  }
};
