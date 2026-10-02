import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { StateRoot } from "@lando/sdk/services";

import { isPathWithin, resolveLandoRoots } from "@lando/paths";

/** Climb only when the caller reports an unresolved candidate; thrown errors propagate. */
export const findRealpathAncestor = async (
  path: string,
  tryRealpath: (candidate: string) => Promise<string | null>,
): Promise<{ readonly ancestor: string; readonly realAncestor: string } | null> => {
  let ancestor = path;
  for (;;) {
    const realAncestor = await tryRealpath(ancestor);
    if (realAncestor !== null) return { ancestor, realAncestor };
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
};

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

/**
 * Resolve through the deepest existing ancestor, then append missing segments.
 * Applying the same rule to the root and target avoids false containment
 * failures when either path has not been created yet.
 */
const realpathOrDeepestExisting = async (path: string): Promise<string> => {
  const found = await findRealpathAncestor(path, (candidate) => realpath(candidate).catch(() => null));
  return found === null ? path : resolve(found.realAncestor, relative(found.ancestor, path));
};

export interface ResolvedStatePath {
  readonly rootReal: string;
  readonly file: string;
}

const sanitizeSegment = (segment: string, operation: string, baseDir: string): string => {
  if (segment.includes("/") || segment.includes("\\")) {
    // Namespace and key each name one segment, never a subpath.
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

      const rootReal = await realpathOrDeepestExisting(baseDir);
      const target = resolve(rootReal, ...segments);

      if (!isPathWithin(rootReal, target)) {
        throw pathError(operation, target);
      }

      // Reject symlinked ancestors that escape an otherwise contained lexical path.
      const targetReal = await realpathOrDeepestExisting(target);
      if (!isPathWithin(rootReal, targetReal)) {
        throw pathError(operation, target);
      }

      return { rootReal, file: target } satisfies ResolvedStatePath;
    },
    catch: (cause) =>
      cause instanceof StateStoreError ? cause : pathError(operation, baseDirForRoot(root), cause),
  });
