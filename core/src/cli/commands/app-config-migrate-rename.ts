import { isDeepStrictEqual } from "node:util";
import { getAtPath, setAtPath, unsetAtPath } from "@lando/engine/config-write/dot-path";
import { parseExpressionEither } from "@lando/sdk/expressions";
import { isPlainRecord } from "@lando/sdk/landofile";
import type { RecipeMigrationHunk } from "@lando/sdk/schema";
import { Result } from "effect";
import { applyServiceMap, dotPath } from "./app-config-recipe-analysis.ts";

/** Compare complete authoring expressions, not a matching substring. */
export const matchesGenerated = (current: unknown, generated: unknown): boolean => {
  if (typeof current === "string" && typeof generated === "string" && generated.includes("{{")) {
    const actual = parseExpressionEither(current, { filePath: ".lando.yml" });
    const expected = parseExpressionEither(generated, { filePath: ".lando.yml" });
    return (
      Result.isSuccess(actual) &&
      Result.isSuccess(expected) &&
      isDeepStrictEqual(actual.success, expected.success)
    );
  }
  return isDeepStrictEqual(current, generated);
};

const getBySegments = (root: unknown, segments: readonly (string | number)[]): unknown => {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
    } else {
      if (!isPlainRecord(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
      cursor = cursor[segment];
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
  const clone = isPlainRecord(root) ? { ...root } : {};
  clone[head] = setBySegments(clone[head], rest, value);
  return clone;
};

type Segments = readonly (string | number)[];
type RenameHunk = Extract<RecipeMigrationHunk, { readonly kind: "rename" }>;
type RenameContext = {
  readonly document: unknown;
  readonly renderedOld: unknown;
  readonly renderedNew: unknown;
  readonly serviceMap: ReadonlyMap<string, string>;
};

const serviceRename = (hunk: RenameHunk) => {
  if (/^services\.[^.[]+$/.test(hunk.old) && /^services\.[^.[]+$/.test(hunk.new)) {
    return { old: hunk.old.slice(9), next: hunk.new.slice(9) };
  }
};

const mapOwner = (segments: Segments, serviceMap: RenameContext["serviceMap"]): Segments => {
  const [root, owner, ...rest] = segments;
  return root === "services" && typeof owner === "string"
    ? [root, serviceMap.get(owner) ?? owner, ...rest]
    : segments;
};

const visitRenameSites = (
  tree: unknown,
  visitors: {
    readonly dependencyMap: (value: Readonly<Record<string, unknown>>, segments: Segments) => void;
    readonly scalar: (value: string, segments: Segments, isReference: boolean) => void;
  },
): void => {
  const visit = (value: unknown, segments: Segments): void => {
    const isDependencyField =
      segments.length === 3 && segments[0] === "services" && segments[2] === "depends_on";
    if (isDependencyField) {
      if (isPlainRecord(value)) visitors.dependencyMap(value, segments);
      else if (Array.isArray(value)) {
        value.forEach((entry: unknown, index) => {
          if (typeof entry === "string") visitors.scalar(entry, [...segments, index], true);
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((entry: unknown, index) => {
        visit(entry, [...segments, index]);
      });
    } else if (isPlainRecord(value)) {
      for (const [key, entry] of Object.entries(value)) visit(entry, [...segments, key]);
    } else if (typeof value === "string") {
      const isReference = segments.at(-1) === "service";
      if (isReference || value.includes("{{")) visitors.scalar(value, segments, isReference);
    }
  };
  visit(tree, []);
};

/** Stage a service move and snapshot-declared reference rewrites on a private tree. */
export const renameMigrationService = (
  hunk: RenameHunk,
  context: RenameContext,
): { readonly kind: "applied"; readonly document: unknown } | { readonly kind: "blocking" } => {
  const source = applyServiceMap(hunk.old, context.serviceMap);
  const target = applyServiceMap(hunk.new, context.serviceMap);
  let document = context.document;
  let blocked = false;
  const rename = serviceRename(hunk);
  const afterSegments = (segments: Segments): Segments => {
    const path = dotPath(segments);
    return path === hunk.old || path.startsWith(`${hunk.old}.`)
      ? [...hunk.new.split("."), ...segments.slice(2)]
      : segments;
  };
  visitRenameSites(context.renderedOld, {
    dependencyMap(value, segments) {
      if (rename === undefined || !Object.hasOwn(value, rename.old)) return;
      const mapped = mapOwner(segments, context.serviceMap);
      const oldKey = source.slice(9);
      const newKey = target.slice(9);
      const current = getBySegments(document, mapped);
      const next = getBySegments(context.renderedNew, [...afterSegments(segments), rename.next]);
      if (
        next === undefined ||
        !isPlainRecord(current) ||
        !Object.hasOwn(current, oldKey) ||
        Object.hasOwn(current, newKey) ||
        !matchesGenerated(current[oldKey], value[rename.old])
      ) {
        blocked = true;
        return;
      }
      const renamed = Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [key === oldKey ? newKey : key, entry]),
      );
      document = setBySegments(document, mapped, renamed);
    },
    scalar(value, segments, isReference) {
      const next = getBySegments(context.renderedNew, afterSegments(segments));
      if (matchesGenerated(value, next)) return;
      const mappedSegments = mapOwner(segments, context.serviceMap);
      const current = getBySegments(document, mappedSegments);
      const expected = isReference ? (context.serviceMap.get(value) ?? value) : value;
      if (!matchesGenerated(current, expected) || next === undefined) {
        blocked = true;
        return;
      }
      const replacement =
        isReference && typeof next === "string" ? (context.serviceMap.get(next) ?? next) : next;
      document = setBySegments(document, mappedSegments, replacement);
    },
  });
  if (blocked) return { kind: "blocking" };
  document = setAtPath(document, target, getAtPath(document, source));
  document = unsetAtPath(document, source).next;
  if (rename !== undefined) {
    document = setAtPath(document, dotPath(["recipe", "services", rename.old]), target.slice(9));
  }
  return { kind: "applied", document };
};

/** True when the document already holds the rendered after-state, including renamed refs. */
export const renameAfterStateMatches = (hunk: RenameHunk, context: RenameContext): boolean => {
  let matches = true;
  const rename = serviceRename(hunk);
  visitRenameSites(context.renderedOld, {
    dependencyMap(value, segments) {
      // The caller compares the whole renamed service against the new snapshot.
      if (rename === undefined || segments[1] === rename.old || !Object.hasOwn(value, rename.old)) return;
      const oldKey = context.serviceMap.get(rename.old) ?? rename.old;
      const newKey = context.serviceMap.get(rename.next) ?? rename.next;
      const current = getBySegments(context.document, mapOwner(segments, context.serviceMap));
      const next = getBySegments(context.renderedNew, [...segments, rename.next]);
      if (
        next === undefined ||
        !isPlainRecord(current) ||
        Object.hasOwn(current, oldKey) ||
        !Object.hasOwn(current, newKey) ||
        !matchesGenerated(current[newKey], next)
      ) {
        matches = false;
      }
    },
    scalar(_value, segments) {
      const path = dotPath(segments);
      if (path === hunk.old || path.startsWith(`${hunk.old}.`)) return;
      const next = getBySegments(context.renderedNew, segments);
      const current = getBySegments(context.document, mapOwner(segments, context.serviceMap));
      if (next === undefined || (!matchesGenerated(current, next) && !isDeepStrictEqual(current, next)))
        matches = false;
    },
  });
  if (rename !== undefined) {
    const mapped = getAtPath(context.document, dotPath(["recipe", "services", rename.old]));
    if (mapped !== rename.next) matches = false;
  }
  return matches;
};
