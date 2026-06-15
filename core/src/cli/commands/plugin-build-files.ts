import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { Data } from "effect";

import type { ExportEntry } from "./plugin-build-package.ts";

export class PluginBuildMixedTreeError extends Data.TaggedError("PluginBuildMixedTreeError")<{
  readonly message: string;
  readonly remediation: string;
  readonly path: string;
}> {}

const isMissingPathError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const findNestedDist = async (dir: string): Promise<string | undefined> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissingPathError(cause)) return [];
    throw cause;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "dist") return path;
    const nested = await findNestedDist(path);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

export const assertNoMixedTrees = async (
  pluginRoot: string,
  entries: ReadonlyArray<ExportEntry>,
): Promise<void> => {
  const nestedDist = await findNestedDist(join(pluginRoot, "src"));
  if (nestedDist !== undefined) {
    throw new PluginBuildMixedTreeError({
      message: `Plugin source tree contains build output at ${nestedDist}.`,
      remediation: "Remove dist output from src/ before running meta:plugin:build.",
      path: nestedDist,
    });
  }
  const hasSourceEntry = entries.some((entry) => entry.source.startsWith("./src/"));
  const hasDistEntry = entries.some((entry) => entry.source.startsWith("./dist/"));
  if (hasSourceEntry && hasDistEntry) {
    throw new PluginBuildMixedTreeError({
      message: "package.json#exports mixes source and dist entrypoints.",
      remediation:
        "Point exports at source entrypoints before building; meta:plugin:build writes dist/package.json.",
      path: join(pluginRoot, "package.json"),
    });
  }
};

export const listOutputs = async (pluginRoot: string): Promise<ReadonlyArray<string>> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      out.push(relative(pluginRoot, absolute).replace(/\\/g, "/"));
    }
  };
  await walk(join(pluginRoot, "dist"));
  return out.sort((left, right) => left.localeCompare(right));
};

export const outputDirectoryExists = async (pluginRoot: string): Promise<boolean> =>
  stat(join(pluginRoot, "dist")).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
