import type { LanguageSource } from "../language/errors.ts";
import { eventError } from "./errors.ts";

// Deliberate bounded subset shared by separate event/hash policies: literals, *, **,
// and ordered leading !. Character classes, escapes, ?, + and extglobs are refused.
export const validatePatterns = (
  patterns: readonly string[],
  source: LanguageSource,
  policy: "event" | "hash",
  allowNegative = true,
): void => {
  if (patterns.length > 128) throw eventError("event-limit", source);
  for (const raw of patterns) {
    const pattern = raw.startsWith("!") && allowNegative ? raw.slice(1) : raw;
    if (
      !pattern ||
      pattern.length > 512 ||
      /[\p{Cc}\p{Cf}\\?[\]{}()+!]/u.test(pattern) ||
      pattern.split("/").some((p) => p === ".." || p === ".") ||
      (policy === "hash" && /^(?:\/|[a-z]:)/iu.test(pattern)) ||
      pattern.includes("***")
    )
      throw eventError("pattern-unsupported", source);
  }
};
export const matchGlob = (
  pattern: string,
  value: string,
  budget: { remaining: number },
  source: LanguageSource,
): boolean => {
  if (value.length > 2048) throw eventError("event-limit", source);
  const cache = new Map<string, boolean>();
  const visit = (p: number, v: number): boolean => {
    const key = `${p}:${v}`;
    const prior = cache.get(key);
    if (prior !== undefined) return prior;
    if (--budget.remaining < 0) throw eventError("event-limit", source);
    let result: boolean;
    if (p === pattern.length) result = v === value.length;
    else if (pattern[p] === "*") {
      const double = pattern[p + 1] === "*";
      const end = p + (double ? 2 : 1);
      result =
        visit(end, v) ||
        (double && pattern[end] === "/" && visit(end + 1, v)) ||
        (v < value.length && (double || value[v] !== "/") && visit(p, v + 1));
    } else result = v < value.length && pattern[p] === value[v] && visit(p + 1, v + 1);
    cache.set(key, result);
    return result;
  };
  return visit(0, 0);
};
export const orderedMatch = (
  patterns: readonly string[],
  value: string,
  budget: { remaining: number },
  source: LanguageSource,
): boolean => {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    if (matchGlob(negative ? pattern.slice(1) : pattern, value, budget, source)) included = !negative;
  }
  return included;
};
