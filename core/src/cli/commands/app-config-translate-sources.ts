import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigTranslateError } from "@lando/sdk/errors";
import { PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

const isContained = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};

const outsideRootError = (file: string): ConfigTranslateError =>
  new ConfigTranslateError({
    message: `Config translator source file "${file}" must be a relative path inside the app root.`,
    remediation:
      "Pass a source file relative to the app root. Reading outside the app root requires an explicit outside-root opt-in before it can be supported.",
  });

export const parseSourceFilePath = (file: string): Effect.Effect<PortablePath, ConfigTranslateError> => {
  const portable = file.replace(/\\/gu, "/");
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    file.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(file) ||
    portable.split("/").includes("..")
  ) {
    return Effect.fail(outsideRootError(file));
  }
  return Effect.succeed(PortablePath.make(portable));
};

export const resolveContainedSourcePath = (
  appRoot: string,
  path: PortablePath,
): Effect.Effect<string, ConfigTranslateError> =>
  Effect.tryPromise({
    try: async () => {
      const lexicalRoot = resolve(appRoot);
      const lexicalPath = resolve(appRoot, path);
      if (!isContained(lexicalRoot, lexicalPath)) throw outsideRootError(path);
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(lexicalRoot),
        realpath(lexicalPath),
      ]);
      if (!isContained(canonicalRoot, canonicalPath)) throw outsideRootError(path);
      return canonicalPath;
    },
    catch: (cause) =>
      cause instanceof ConfigTranslateError
        ? cause
        : new ConfigTranslateError({
            message: `Could not read translation source ${path}.`,
            cause,
            remediation: "Check that the source file exists and is readable.",
          }),
  });

const containedRegularFile = async (rootReal: string, absolute: string): Promise<boolean> => {
  try {
    const real = await realpath(absolute);
    if (!isContained(rootReal, real)) return false;
    return (await stat(real)).isFile();
  } catch {
    return false;
  }
};

// Dependency, VCS, and temporary trees are not application config sources.
const DISCOVERY_PRUNED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git", "vendor", "tmp"]);

export const discoverSourceFiles = (
  appRoot: string,
): Effect.Effect<ReadonlyArray<PortablePath>, ConfigTranslateError> =>
  Effect.tryPromise({
    try: async () => {
      const files: PortablePath[] = [];
      const rootReal = await realpath(appRoot);
      const visit = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const absolute = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!DISCOVERY_PRUNED_DIRECTORIES.has(entry.name)) await visit(absolute);
            continue;
          }
          if (
            (entry.isFile() || entry.isSymbolicLink()) &&
            (await containedRegularFile(rootReal, absolute))
          ) {
            files.push(PortablePath.make(relative(appRoot, absolute).replace(/\\/gu, "/")));
          }
        }
      };
      await visit(appRoot);
      return files.sort();
    },
    catch: (cause) =>
      new ConfigTranslateError({
        message: `Could not discover config translator source files: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
