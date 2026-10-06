import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { isErrnoCode } from "@lando/sdk/errors";
import { Schema } from "effect";

import type { ExportEntry } from "./plugin-build-package";

export class PluginBuildMixedTreeError extends Schema.TaggedError<PluginBuildMixedTreeError>()(
  "PluginBuildMixedTreeError",
  {
    message: Schema.String,
    remediation: Schema.String,
    path: Schema.String,
  },
) {}

const findNestedDist = async (dir: string): Promise<string | undefined> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch((cause: unknown) => {
    if (isErrnoCode(cause, "ENOENT")) return [];
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

const withoutDotPrefix = (path: string): string => path.replace(/^\.\//, "");

const isDistEntrypoint = (source: string): boolean => source === "./dist" || source.startsWith("./dist/");

const sourceTreeRoots = (entries: ReadonlyArray<ExportEntry>): ReadonlyArray<string> => {
  const roots = new Set<string>();
  for (const entry of entries) {
    if (isDistEntrypoint(entry.source)) continue;
    const parts = withoutDotPrefix(entry.source).split("/");
    const [root] = parts;
    if (parts.length > 1 && root !== undefined && root !== "") roots.add(root);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
};

export const assertNoMixedTrees = async (
  pluginRoot: string,
  entries: ReadonlyArray<ExportEntry>,
): Promise<void> => {
  for (const root of sourceTreeRoots(entries)) {
    const nestedDist = await findNestedDist(join(pluginRoot, root));
    if (nestedDist !== undefined) {
      throw new PluginBuildMixedTreeError({
        message: `Plugin source tree contains build output at ${nestedDist}.`,
        remediation: `Remove dist output from ${root}/ before running meta:plugin:build.`,
        path: nestedDist,
      });
    }
  }
  const hasSourceEntry = entries.some((entry) => !isDistEntrypoint(entry.source));
  const hasDistEntry = entries.some((entry) => isDistEntrypoint(entry.source));
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
