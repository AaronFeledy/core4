import type { ValidationIssuePath } from "@lando/sdk/schema";

export const pathHasPrefix = (path: ValidationIssuePath, prefix: ValidationIssuePath): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => path[index] === part);

export const pathsOverlap = (left: ValidationIssuePath, right: ValidationIssuePath): boolean =>
  left.length < right.length ? pathHasPrefix(right, left) : pathHasPrefix(left, right);

export const loadEntrySections: readonly string[] = ["services", "networks", "proxy", "tooling", "events"];

export const unavailableEntryPath = (path: ValidationIssuePath): ValidationIssuePath =>
  loadEntrySections.includes(String(path[0])) ? path.slice(0, 2) : path;

const probeTargetFields = ["target", "user", "kind", "command"];

/** Fields read by authoredProbeTargetError (as opposed to unrelated probe options). */
export const probeTargetIsBlocked = (
  path: ValidationIssuePath,
  isBlocked: (path: ValidationIssuePath) => boolean,
): boolean => probeTargetFields.some((field) => isBlocked([...path, field]));
