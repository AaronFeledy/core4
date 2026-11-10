import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { BunShellScriptFrontMatterError, causeMessage, isErrnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";
import {
  SCRIPTS_DIRNAME,
  bunShellScriptPaths,
  canonicalIdFromRelativePath,
  parseScriptFile,
  scriptCollisionError,
} from "./bun-sh-discovery.ts";
import { readScriptContent, scriptServiceProblem } from "./bun-sh-inspection.ts";

const checkedScriptPath = Effect.fnUntraced(function* (appRoot: string, relativePath: string) {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment.startsWith(".") || segment.includes(":")))
    return undefined;
  let path = join(appRoot, SCRIPTS_DIRNAME);
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const stats = yield* Effect.tryPromise({
      try: () =>
        lstat(path).catch((cause: unknown) => {
          if (isErrnoCode(cause, "ENOENT")) return undefined;
          throw cause;
        }),
      catch: (cause) =>
        new BunShellScriptFrontMatterError({
          message: `Cannot inspect script path ${path}: ${causeMessage(cause)}`,
          path,
          cause,
          remediation: "Check script path permissions and remove symlink loops before retrying.",
        }),
    });
    if (index === segments.length - 1 ? stats?.isFile() !== true : stats?.isDirectory() !== true)
      return undefined;
  }
  return path;
});

export const readBunShellScript = Effect.fnUntraced(function* (appRoot: string, relativePath: string) {
  const path = yield* checkedScriptPath(appRoot, relativePath);
  return path === undefined ? undefined : yield* parseScriptFile(path, relativePath);
});

/** Reads a cached script path without parsing it, so freshness parses only what it must. */
export const readBunShellScriptSource = Effect.fnUntraced(function* (appRoot: string, relativePath: string) {
  const path = yield* checkedScriptPath(appRoot, relativePath);
  return path === undefined ? undefined : { path, content: yield* readScriptContent(path) };
});

export const resolveBunShellScript = Effect.fnUntraced(function* (appRoot: string, name: string) {
  const id = name.startsWith("app:") ? name : `app:${name}`;
  const paths = (yield* bunShellScriptPaths(appRoot)).filter(
    (entry) => canonicalIdFromRelativePath(entry.relativePath)?.id === id,
  );
  if (paths.length > 1)
    return yield* Effect.fail(
      scriptCollisionError(
        id,
        paths.map((entry) => entry.absolutePath),
      ),
    );
  const path = paths[0];
  if (path === undefined) return undefined;
  const script = yield* readBunShellScript(appRoot, path.relativePath);
  if (script === undefined) return undefined;
  const problem = scriptServiceProblem(script, "");
  if (problem !== undefined) return yield* Effect.fail(problem.error);
  return script;
});
