/**
 * Pure dot-path grammar for config write verbs. Operates on plain
 * encoded objects (records/arrays/scalars) — the wire form the canonical
 * Landofile serializer consumes. Supports dot separators and `[n]` bracket
 * array indexing, e.g. `services.appserver.environment.APP_ENV` and
 * `tooling.test.cmds[0]`. All mutations are immutable (return a new tree).
 */

export type PathSegment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number };

/** Parse a dot/bracket path into ordered segments. Returns `undefined` on malformed syntax. */
export const parsePathSegments = (path: string): ReadonlyArray<PathSegment> | undefined => {
  if (path === "") return undefined;
  const segments: PathSegment[] = [];
  for (const rawPart of path.split(".")) {
    if (rawPart === "") return undefined;
    // A part may carry trailing bracket indices: `cmds[0][1]` or a leading index `[0]`.
    let cursor = 0;
    const bracketStart = rawPart.indexOf("[");
    const keyPart = bracketStart === -1 ? rawPart : rawPart.slice(0, bracketStart);
    if (keyPart !== "") {
      segments.push({ kind: "key", key: keyPart });
      cursor = keyPart.length;
    } else if (bracketStart !== 0) {
      return undefined;
    }
    while (cursor < rawPart.length) {
      if (rawPart[cursor] !== "[") return undefined;
      const close = rawPart.indexOf("]", cursor);
      if (close === -1) return undefined;
      const inner = rawPart.slice(cursor + 1, close);
      if (!/^\d+$/.test(inner)) return undefined;
      segments.push({ kind: "index", index: Number(inner) });
      cursor = close + 1;
    }
  }
  return segments.length === 0 ? undefined : segments;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read the value at a dot/bracket path, or `undefined` if any segment is absent. */
export const getAtPath = (root: unknown, path: string): unknown => {
  const segments = parsePathSegments(path);
  if (segments === undefined) return undefined;
  let cursor: unknown = root;
  for (const segment of segments) {
    if (segment.kind === "key") {
      if (!isRecord(cursor)) return undefined;
      cursor = cursor[segment.key];
    } else {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment.index];
    }
  }
  return cursor;
};

const cloneContainer = (value: unknown, wantArray: boolean): unknown[] | Record<string, unknown> => {
  if (wantArray) return Array.isArray(value) ? [...value] : [];
  return isRecord(value) ? { ...value } : {};
};

const setRecursive = (
  container: unknown,
  segments: ReadonlyArray<PathSegment>,
  cursor: number,
  value: unknown,
): unknown => {
  const segment = segments[cursor];
  if (segment === undefined) return value;
  const isLast = cursor === segments.length - 1;
  if (segment.kind === "key") {
    const clone = cloneContainer(container, false) as Record<string, unknown>;
    clone[segment.key] = isLast ? value : setRecursive(clone[segment.key], segments, cursor + 1, value);
    return clone;
  }
  const clone = cloneContainer(container, true) as unknown[];
  clone[segment.index] = isLast ? value : setRecursive(clone[segment.index], segments, cursor + 1, value);
  return clone;
};

/** Return a new tree with `value` written at the dot/bracket path (creating intermediate containers). */
export const setAtPath = (root: unknown, path: string, value: unknown): unknown => {
  const segments = parsePathSegments(path);
  if (segments === undefined) return root;
  return setRecursive(root, segments, 0, value);
};

const unsetRecursive = (
  container: unknown,
  segments: ReadonlyArray<PathSegment>,
  cursor: number,
): { readonly next: unknown; readonly changed: boolean } => {
  const segment = segments[cursor];
  if (segment === undefined) return { next: container, changed: false };
  const isLast = cursor === segments.length - 1;
  if (segment.kind === "key") {
    if (!isRecord(container) || !(segment.key in container)) return { next: container, changed: false };
    const clone = { ...container };
    if (isLast) {
      delete clone[segment.key];
      return { next: clone, changed: true };
    }
    const child = unsetRecursive(clone[segment.key], segments, cursor + 1);
    if (!child.changed) return { next: container, changed: false };
    clone[segment.key] = child.next;
    return { next: clone, changed: true };
  }
  if (!Array.isArray(container) || segment.index >= container.length)
    return { next: container, changed: false };
  if (isLast) {
    const clone = [...container];
    clone.splice(segment.index, 1);
    return { next: clone, changed: true };
  }
  const clone = [...container];
  const child = unsetRecursive(clone[segment.index], segments, cursor + 1);
  if (!child.changed) return { next: container, changed: false };
  clone[segment.index] = child.next;
  return { next: clone, changed: true };
};

/** Remove the value at a dot/bracket path. A missing path is a no-op (`changed:false`). */
export const unsetAtPath = (
  root: unknown,
  path: string,
): { readonly next: unknown; readonly changed: boolean } => {
  const segments = parsePathSegments(path);
  if (segments === undefined) return { next: root, changed: false };
  return unsetRecursive(root, segments, 0);
};
