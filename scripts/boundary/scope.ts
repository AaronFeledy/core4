import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import type { Dirent } from "node:fs";

import type { FileRecord, RuleScope } from "./types.ts";

const normalizePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//u, "");

const normalizeRoot = (path: string): string => normalizePath(path).replace(/\/$/u, "");

const segmentsMatch = (pathSegments: readonly string[], patternSegments: readonly string[]): boolean =>
  pathSegments.every((segment, index) => {
    const pattern = patternSegments[index];
    return pattern === undefined || pattern === "*" || pattern === segment;
  });

/**
 * Segments of a scope root. The repository root is spelled `""` or `"."` and
 * yields no segments, so every walked file lives under it.
 */
const rootSegments = (root: string): readonly string[] => {
  const normalized = normalizeRoot(root);
  return normalized === "" || normalized === "." ? [] : normalized.split("/");
};

const canReachRoot = (directory: string, root: string): boolean => {
  const directorySegments = directory === "" ? [] : directory.split("/");
  const segments = rootSegments(root);
  const sharedLength = Math.min(directorySegments.length, segments.length);
  return segmentsMatch(directorySegments.slice(0, sharedLength), segments.slice(0, sharedLength));
};

const isUnderRoot = (path: string, root: string): boolean => {
  const pathSegments = path.split("/");
  const segments = rootSegments(root);
  if (pathSegments.length <= segments.length) return false;
  return segmentsMatch(pathSegments.slice(0, segments.length), segments);
};

const directoryIsExcluded = (directory: string, scope: RuleScope): boolean => {
  const segments = directory === "" ? [] : directory.split("/");
  const dirNames = new Set(scope.excludeDirNames ?? []);
  const pathSegments = new Set(scope.excludePathSegments ?? []);
  return segments.some((segment) => dirNames.has(segment) || pathSegments.has(segment));
};

const pathIsExcluded = (relativePath: string, scope: RuleScope): boolean => {
  const directory = relativePath.split("/").slice(0, -1).join("/");
  if (directoryIsExcluded(directory, scope)) return true;
  if (scope.excludeTestFiles === true && /\.test\.(?:ts|tsx|mts|cts)$/u.test(relativePath)) return true;
  if ((scope.excludeFiles ?? []).some((file) => normalizePath(file) === relativePath)) return true;
  return (scope.excludePrefixes ?? []).some((prefix) => relativePath.startsWith(normalizePath(prefix)));
};

export const fileMatchesScope = (relativePathInput: string, scope: RuleScope): boolean => {
  const relativePath = normalizePath(relativePathInput);
  if (!scope.extensions.includes(extname(relativePath))) return false;
  if (!scope.roots.some((root) => isUnderRoot(relativePath, root))) return false;
  return !pathIsExcluded(relativePath, scope);
};

const activeScopesForDirectory = (directory: string, scopes: readonly RuleScope[]): readonly RuleScope[] =>
  scopes.filter(
    (scope) =>
      !directoryIsExcluded(directory, scope) && scope.roots.some((root) => canReachRoot(directory, root)),
  );

const readDirectory = async (directory: string): Promise<readonly Dirent[]> => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};

export const walkFiles = async (
  rootInput: string,
  scopes: readonly RuleScope[],
): Promise<readonly FileRecord[]> => {
  const root = resolve(rootInput);
  const files = new Map<string, FileRecord>();

  const walk = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    activeScopes: readonly RuleScope[],
  ): Promise<void> => {
    const entries = (await readDirectory(absoluteDirectory))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        const nextScopes = activeScopesForDirectory(relativePath, activeScopes);
        if (nextScopes.length > 0) await walk(absolutePath, relativePath, nextScopes);
      } else if (entry.isFile() && activeScopes.some((scope) => fileMatchesScope(relativePath, scope))) {
        files.set(relativePath, { relativePath, absolutePath });
      }
    }
  };

  await walk(root, "", scopes);
  return [...files.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};
