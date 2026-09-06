import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ConfigTranslateError } from "@lando/sdk/errors";
import { PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

export const parseSourceFilePath = (file: string): Effect.Effect<PortablePath, ConfigTranslateError> => {
  const portable = file.replace(/\\/gu, "/");
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    file.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(file) ||
    portable.split("/").includes("..")
  ) {
    return Effect.fail(
      new ConfigTranslateError({
        message: `Config translator source file "${file}" must be a relative path inside the app root.`,
        remediation:
          "Pass a source file relative to the app root. Reading outside the app root requires an explicit outside-root opt-in before it can be supported.",
      }),
    );
  }
  return Effect.succeed(PortablePath.make(portable));
};

// Dependency, VCS, and temporary trees are not application config sources.
const DISCOVERY_PRUNED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git", "vendor", "tmp"]);

export const discoverSourceFiles = (
  appRoot: string,
): Effect.Effect<ReadonlyArray<PortablePath>, ConfigTranslateError> =>
  Effect.tryPromise({
    try: async () => {
      const files: PortablePath[] = [];
      const visit = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const absolute = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!DISCOVERY_PRUNED_DIRECTORIES.has(entry.name)) await visit(absolute);
            continue;
          }
          if (entry.isFile()) {
            files.push(PortablePath.make(relative(appRoot, absolute).replace(/\\/gu, "/")));
            continue;
          }
          if (entry.isSymbolicLink()) {
            const target = await stat(absolute).catch((cause: unknown) => {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
              throw cause;
            });
            if (target?.isFile() === true)
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
