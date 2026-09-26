import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { type ConfigTranslateDiagnostic, type ConfigTranslateOutput, PortablePath } from "@lando/sdk/schema";
import { Effect, Either } from "effect";
import { resolveContainedSourcePath } from "./app-config-translate-sources.ts";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

/**
 * Include targets are app-root relative after `.` and `..` collapse. A `..`
 * that stays inside the app is the same file; one that leaves it is not.
 * Absolute, drive, and UNC paths never collapse into the root.
 */
const containedIncludePath = (source: string): PortablePath | undefined => {
  const portable = source.replace(/\\/gu, "/");
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    source.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(source)
  ) {
    return undefined;
  }
  const segments: string[] = [];
  for (const part of portable.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.length === 0 ? undefined : PortablePath.make(segments.join("/"));
};

export const validateTranslatedIncludeTargets = (
  appRoot: string,
  outputs: ReadonlyArray<ConfigTranslateOutput>,
): Effect.Effect<ReadonlyArray<ConfigTranslateDiagnostic>, never> =>
  Effect.gen(function* () {
    const diagnostics: ConfigTranslateDiagnostic[] = [];
    for (const output of outputs) {
      const sourceId = output.sourceIds[0];
      if (sourceId === undefined || !Array.isArray(output.fragment.includes)) continue;
      for (const [index, entry] of output.fragment.includes.entries()) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          entry.kind !== "compose" ||
          typeof entry.source !== "string" ||
          entry.source.includes("://") ||
          entry.source.startsWith("git@")
        )
          continue;
        const problem = yield* Effect.gen(function* () {
          const path = containedIncludePath(entry.source);
          if (path === undefined) return "target must be a relative path inside the app root";
          const metadata = yield* Effect.either(Effect.tryPromise(() => lstat(resolve(appRoot, path))));
          if (Either.isLeft(metadata)) return "target does not exist";
          if (metadata.right.isSymbolicLink()) return "target is a symbolic link";
          if (!metadata.right.isFile()) return "target is not a regular file";
          const contained = yield* Effect.either(resolveContainedSourcePath(appRoot, path));
          return Either.isLeft(contained) ? "target resolves outside the app root" : undefined;
        });
        if (problem !== undefined)
          diagnostics.push({
            kind: "unsupported",
            sourceId,
            keyPath: ["includes", index],
            message: `Compose include ${problem}.`,
            remediation:
              "Use an existing regular file inside the app root, referenced by a relative path without symlinks.",
          });
      }
    }
    return diagnostics;
  });
