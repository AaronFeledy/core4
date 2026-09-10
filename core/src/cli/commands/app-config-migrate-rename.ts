import { isDeepStrictEqual } from "node:util";
import { getAtPath, setAtPath, unsetAtPath } from "@lando/engine/config-write/dot-path";
import { parseExpressionEither } from "@lando/sdk/expressions";
import type { RecipeMigrationHunk } from "@lando/sdk/schema";
import { Either } from "effect";
import { applyServiceMap, dotPath } from "./app-config-recipe-analysis.ts";

/** Compare complete authoring expressions, not a matching substring. */
export const matchesGenerated = (current: unknown, generated: unknown): boolean => {
  if (typeof current === "string" && typeof generated === "string" && generated.includes("{{")) {
    const actual = parseExpressionEither(current, { filePath: ".lando.yml" });
    const expected = parseExpressionEither(generated, { filePath: ".lando.yml" });
    return (
      Either.isRight(actual) && Either.isRight(expected) && isDeepStrictEqual(actual.right, expected.right)
    );
  }
  return isDeepStrictEqual(current, generated);
};

const getBySegments = (root: unknown, segments: readonly (string | number)[]): unknown => {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
    } else {
      if (Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
};

const setBySegments = (root: unknown, segments: readonly (string | number)[], value: unknown): unknown => {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (typeof head === "number") {
    const clone = Array.isArray(root) ? [...root] : [];
    clone[head] = setBySegments(clone[head], rest, value);
    return clone;
  }
  const clone =
    root !== null && typeof root === "object" && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>) }
      : {};
  clone[head] = setBySegments(clone[head], rest, value);
  return clone;
};

/** Stage a service move and snapshot-declared reference rewrites on a private tree. */
export const renameMigrationService = (
  hunk: Extract<RecipeMigrationHunk, { readonly kind: "rename" }>,
  context: {
    readonly document: unknown;
    readonly renderedOld: unknown;
    readonly renderedNew: unknown;
    readonly serviceMap: ReadonlyMap<string, string>;
  },
): { readonly kind: "applied"; readonly document: unknown } | { readonly kind: "blocking" } => {
  const source = applyServiceMap(hunk.old, context.serviceMap);
  const target = applyServiceMap(hunk.new, context.serviceMap);
  let document = context.document;
  let blocked = false;
  const visit = (value: unknown, segments: readonly (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry: unknown, index) => visit(entry, [...segments, index]));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, [...segments, key]);
      return;
    }
    if (typeof value !== "string") return;
    const path = dotPath(segments);
    const isReference = segments.includes("dependsOn") || segments.at(-1) === "service";
    if (!isReference && !value.includes("{{")) return;
    const nextSegments =
      path === hunk.old || path.startsWith(`${hunk.old}.`)
        ? [...hunk.new.split("."), ...segments.slice(2)]
        : segments;
    const next = getBySegments(context.renderedNew, nextSegments);
    if (matchesGenerated(value, next)) return;
    const mappedSegments =
      segments[0] === "services" && typeof segments[1] === "string" && context.serviceMap.has(segments[1])
        ? [segments[0], context.serviceMap.get(segments[1]) ?? segments[1], ...segments.slice(2)]
        : segments;
    const current = getBySegments(document, mappedSegments);
    const expected = isReference ? (context.serviceMap.get(value) ?? value) : value;
    if (!matchesGenerated(current, expected) || next === undefined) {
      blocked = true;
      return;
    }
    const replacement =
      isReference && typeof next === "string" ? (context.serviceMap.get(next) ?? next) : next;
    document = setBySegments(document, mappedSegments, replacement);
  };
  visit(context.renderedOld, []);
  if (blocked) return { kind: "blocking" };
  document = setAtPath(document, target, getAtPath(document, source));
  document = unsetAtPath(document, source).next;
  if (/^services\.[^.\[]+$/.test(hunk.old) && /^services\.[^.\[]+$/.test(hunk.new)) {
    document = setAtPath(document, dotPath(["recipe", "services", hunk.old.slice(9)]), target.slice(9));
  }
  return { kind: "applied", document };
};
