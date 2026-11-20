import { type ValidationIssuePath, parseValidationIssuePath } from "@lando/sdk/schema";
import { Predicate } from "effect";

export const parsePathSegments = (selector: string): ValidationIssuePath | undefined =>
  selector === "" ? undefined : parseValidationIssuePath(selector);

/**
 * Parse a selector against the document it addresses. A bare canonical integer segment (`list.0`)
 * indexes an array it reaches, as it always has; on a map it stays a key. `[0]` always indexes and
 * `["0"]` never does.
 */
export const resolveSelector = (root: unknown, selector: string): ValidationIssuePath | undefined => {
  if (selector === "") return undefined;
  const bareIndexes = new Set<number>();
  const parsed = parseValidationIssuePath(selector, (position, key) => {
    if (/^(0|[1-9]\d*)$/u.test(key) && Number.isSafeInteger(Number(key))) bareIndexes.add(position);
  });
  if (parsed === undefined) return undefined;
  let cursor = root;
  return parsed.map((segment, position) => {
    const resolved = Array.isArray(cursor) && bareIndexes.has(position) ? Number(segment) : segment;
    cursor = childAt(cursor, resolved);
    return resolved;
  });
};

const childAt = (container: unknown, segment: string | number): unknown => {
  if (Array.isArray(container)) return typeof segment === "number" ? container[segment] : undefined;
  return typeof segment === "string" && Predicate.isObject(container) && Object.hasOwn(container, segment)
    ? container[segment]
    : undefined;
};

/** The first position where a key segment meets an existing array, which only `[n]` can address. */
export const listAddressedByKey = (root: unknown, path: ValidationIssuePath): number | undefined => {
  let cursor = root;
  for (const [position, segment] of path.entries()) {
    if (Array.isArray(cursor) && typeof segment === "string") return position;
    cursor = childAt(cursor, segment);
  }
  return undefined;
};

export const getAtPath = (root: unknown, selector: string | ValidationIssuePath): unknown => {
  const path = typeof selector === "string" ? resolveSelector(root, selector) : selector;
  return path?.reduce<unknown>(childAt, root);
};

export const setAtPath = (root: unknown, selector: string | ValidationIssuePath, value: unknown): unknown => {
  const path = typeof selector === "string" ? resolveSelector(root, selector) : selector;
  if (path === undefined) return root;
  const set = (container: unknown, cursor: number): unknown => {
    const segment = path[cursor];
    if (segment === undefined) return value;
    if (typeof segment === "number") {
      const copy: unknown[] = Array.isArray(container) ? [...container] : [];
      copy[segment] = set(copy[segment], cursor + 1);
      return copy;
    }
    const record = Predicate.isObject(container) && !Array.isArray(container) ? container : {};
    const child = Object.hasOwn(record, segment) ? record[segment] : undefined;
    return { ...record, [segment]: set(child, cursor + 1) };
  };
  return set(root, 0);
};

export const unsetAtPath = (
  root: unknown,
  selector: string | ValidationIssuePath,
): { readonly next: unknown; readonly changed: boolean } => {
  const path = typeof selector === "string" ? resolveSelector(root, selector) : selector;
  if (path === undefined) return { next: root, changed: false };
  const unset = (container: unknown, cursor: number): ReturnType<typeof unsetAtPath> => {
    const segment = path[cursor];
    const last = cursor === path.length - 1;
    if (typeof segment === "number" && Array.isArray(container) && segment < container.length) {
      const copy: unknown[] = [...container];
      if (last) copy.splice(segment, 1);
      else {
        const child = unset(copy[segment], cursor + 1);
        if (!child.changed) return { next: container, changed: false };
        copy[segment] = child.next;
      }
      return { next: copy, changed: true };
    }
    if (
      typeof segment === "string" &&
      Predicate.isObject(container) &&
      !Array.isArray(container) &&
      Object.hasOwn(container, segment)
    ) {
      if (last) {
        const copy = { ...container };
        delete copy[segment];
        return { next: copy, changed: true };
      }
      const child = unset(container[segment], cursor + 1);
      if (!child.changed) return { next: container, changed: false };
      return { next: { ...container, [segment]: child.next }, changed: true };
    }
    return { next: container, changed: false };
  };
  return unset(root, 0);
};
