// Resolve a `StateBucketSpec`'s `(root, namespace?, key)` to a concrete,
// containment-checked absolute file path. Root resolution flows through the
// single `@lando/core/paths` primitive (`resolveLandoRoots`) — never a
// re-derived `$HOME`/XDG/`%APPDATA%` fallback — so the named roots stay in
// lockstep with every other Lando path. The `{ app }` / `{ path }` roots pin an
// explicit absolute directory for app-scoping and host/test isolation.

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { StateRoot } from "@lando/sdk/services";

import { resolveLandoRoots } from "../config/paths.ts";

/** Resolve a {@link StateRoot} to its base directory through the Paths primitive. */
const baseDirForRoot = (root: StateRoot): string => {
  if (typeof root === "object") {
    return "app" in root ? root.app : root.path;
  }
  const roots = resolveLandoRoots();
  switch (root) {
    case "userData":
      return roots.userDataRoot;
    case "userCache":
      return roots.userCacheRoot;
    case "userConf":
      return roots.userConfRoot;
  }
};

const pathError = (operation: string, path: string, cause?: unknown): StateStoreError =>
  new StateStoreError({
    reason: "path",
    operation,
    path,
    ...(cause === undefined ? {} : { cause }),
    remediation: "State paths must stay inside the resolved state root.",
  });

const realpathOrSelf = (path: string): Promise<string> => realpath(path).catch(() => path);

/** Resolve realpath of the deepest existing ancestor of `target`. */
const realpathDeepestExisting = async (target: string): Promise<string> => {
  let current = target;
  // Walk up until a segment resolves (the bucket file usually does not exist yet).
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return real;
    const parent = resolve(current, "..");
    if (parent === current) return current; // reached filesystem root
    current = parent;
  }
};

/**
 * The resolved location of a single durable document: the realpath-checked base
 * root and the final absolute file path. `file` is guaranteed lexically and
 * (for already-existing ancestors) realpath-contained within `rootReal`.
 */
export interface ResolvedStatePath {
  readonly rootReal: string;
  readonly file: string;
}

const sanitizeSegment = (segment: string, operation: string, baseDir: string): string => {
  if (segment.includes("/") || segment.includes("\\")) {
    // Reject embedded separators outright: `namespace`/`key` name one path
    // segment each, never a sub-path that could climb out of the root.
    throw pathError(operation, baseDir);
  }
  return segment;
};

/**
 * Resolve `(root, namespace?, key)` to a contained absolute file path, failing
 * with {@link StateStoreError} (`reason: "path"`) if the realpath of the target
 * escapes the resolved root. `realpath` is applied to the root and to the
 * deepest existing ancestor of the target so a symlinked escape is rejected even
 * before the file exists.
 */
export const resolveStatePath = (
  root: StateRoot,
  namespace: string | undefined,
  key: string,
  operation: string,
): Effect.Effect<ResolvedStatePath, StateStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const baseDir = baseDirForRoot(root);
      const segments: string[] = [];
      if (namespace !== undefined && namespace !== "")
        segments.push(sanitizeSegment(namespace, operation, baseDir));
      segments.push(sanitizeSegment(key, operation, baseDir));

      const rootReal = await realpathOrSelf(baseDir);
      const target = resolve(rootReal, ...segments);

      const rel = relative(rootReal, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw pathError(operation, target);
      }

      // Reject a symlinked ancestor that resolves outside the root even though
      // the lexical path looked contained.
      const ancestorReal = await realpathDeepestExisting(target);
      const ancestorRel = relative(rootReal, ancestorReal);
      if (ancestorRel === ".." || ancestorRel.startsWith(`..${sep}`) || isAbsolute(ancestorRel)) {
        throw pathError(operation, target);
      }

      return { rootReal, file: target } satisfies ResolvedStatePath;
    },
    catch: (cause) =>
      cause instanceof StateStoreError ? cause : pathError(operation, baseDirForRoot(root), cause),
  });
