import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { StateRoot } from "@lando/sdk/services";

import { resolveLandoRoots } from "@lando/paths";

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
  const tailSegments: Array<string> = [];
  let current = path;
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return tailSegments.length === 0 ? real : resolve(real, ...tailSegments.reverse());
    const parent = resolve(current, "..");
    if (parent === current) return path; // reached filesystem root without resolving anything
    tailSegments.push(basename(current));
    current = parent;
  }
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

      const rel = relative(rootReal, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw pathError(operation, target);
      }

      // Reject symlinked ancestors that escape an otherwise contained lexical path.
      const targetReal = await realpathOrDeepestExisting(target);
      const targetRel = relative(rootReal, targetReal);
      if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
        throw pathError(operation, target);
      }

      return { rootReal, file: target } satisfies ResolvedStatePath;
    },
    catch: (cause) =>
      cause instanceof StateStoreError ? cause : pathError(operation, baseDirForRoot(root), cause),
  });
