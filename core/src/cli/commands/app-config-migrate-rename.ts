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
    const isReference =
      segments.includes("dependsOn") || (segments[0] === "tooling" && segments.at(-1) === "service");
    if (!isReference && !value.includes("{{")) return;
    // The new snapshot is the authoring authority, including expression syntax.
    const nextPath =
      path === hunk.old || path.startsWith(`${hunk.old}.`)
        ? `${hunk.new}${path.slice(hunk.old.length)}`
        : path;
    const next = getAtPath(context.renderedNew, nextPath);
    if (matchesGenerated(value, next)) return;
    const mapped = applyServiceMap(path, context.serviceMap);
    const current = getAtPath(document, mapped);
    const expected = isReference ? (context.serviceMap.get(value) ?? value) : value;
    if (!matchesGenerated(current, expected) || next === undefined) {
      blocked = true;
      return;
    }
    const replacement =
      isReference && typeof next === "string" ? (context.serviceMap.get(next) ?? next) : next;
    document = setAtPath(document, mapped, replacement);
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
