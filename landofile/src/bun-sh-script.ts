import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  BUN_SHELL_SCRIPT_EXTENSION,
  SCRIPTS_DIRNAME,
  canonicalIdFromRelativePath,
  parseScriptFile,
} from "./bun-sh-discovery.ts";

export const readBunShellScript = Effect.fnUntraced(function* (appRoot: string, relativePath: string) {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment.startsWith(".") || segment.includes(":")))
    return undefined;
  let path = join(appRoot, SCRIPTS_DIRNAME);
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const stats = yield* Effect.promise(() => lstat(path).catch(() => undefined));
    if (index === segments.length - 1 ? stats?.isFile() !== true : stats?.isDirectory() !== true)
      return undefined;
  }
  return yield* parseScriptFile(path, relativePath);
});

export const resolveBunShellScript = Effect.fnUntraced(function* (appRoot: string, name: string) {
  const relativePath = `${name.split(":").join("/")}${BUN_SHELL_SCRIPT_EXTENSION}`;
  if (canonicalIdFromRelativePath(relativePath)?.name !== name) return undefined;
  return yield* readBunShellScript(appRoot, relativePath);
});
