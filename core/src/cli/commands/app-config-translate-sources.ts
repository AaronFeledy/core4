import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const segments = portable.split("/").filter((part) => part !== ".");
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    file.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(file) ||
    segments.includes("..") ||
    segments.length === 0
  ) {
    return Effect.fail(outsideRootError(file));
  }
  return Effect.succeed(PortablePath.make(segments.join("/")));
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

/**
 * Extensions core treats as candidate configuration documents. Path policy is
 * core's, not a translator's: application code and assets never enter the
 * document set, so no translator has to reject them as unsupported input.
 */
const CONFIG_SOURCE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".json": "application/json",
  ".toml": "application/toml",
};

export const mediaTypeForSourcePath = (path: string): string =>
  CONFIG_SOURCE_MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const isConfigSourceExtension = (name: string): boolean =>
  Object.hasOwn(CONFIG_SOURCE_MEDIA_TYPES, extname(name).toLowerCase());

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
            isConfigSourceExtension(entry.name) &&
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

/** --file may only select inside the extension-filtered discovered set. */
export const rejectUndiscoveredSources = (
  appRoot: string,
  discovered: ReadonlyArray<PortablePath>,
  explicit: ReadonlyArray<PortablePath>,
): Effect.Effect<void, ConfigTranslateError> =>
  Effect.gen(function* () {
    const discoveredIds = new Set(discovered.map(String));
    for (const path of explicit) {
      if (discoveredIds.has(String(path))) continue;
      yield* resolveContainedSourcePath(appRoot, path);
      return yield* Effect.fail(
        new ConfigTranslateError({
          message: `Config translator source file "${path}" is not a discovered configuration document.`,
          remediation:
            "Pass --file with a .yml, .yaml, .json, or .toml path that discovery already selected inside the app root.",
        }),
      );
    }
  });
