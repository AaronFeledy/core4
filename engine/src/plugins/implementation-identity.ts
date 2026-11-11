import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { packageRootPath } from "./plugin-module-path.ts";

/** Machine-local executable identity. No file contents are read. */
export interface PluginImplementation {
  readonly realpath: string;
  readonly identity: string;
  readonly dependencies: string;
  readonly files: readonly string[];
}

const tuple = (value: BigIntStats) => [value.size, value.mtimeNs, value.ctimeNs, value.ino].map(String);

const digest = (entries: readonly unknown[]) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(entries)).digest("hex");

export const pluginImplementationIdentity = async (path: string): Promise<PluginImplementation> => {
  const root = await realpath(packageRootPath(path));
  const files: unknown[] = [];
  const paths: string[] = [];
  // Symlinks contribute their literal target and target stat, but are never traversed.
  // This also prevents cycles and traversal outside the canonical package root.
  const observe = async (file: string, observed?: BigIntStats) => {
    const value = observed ?? (await lstat(file, { bigint: true }));
    if (value.isSymbolicLink()) {
      const target = await readlink(file);
      const targetStat = await stat(file, { bigint: true }).then(tuple, (cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      });
      return [relative(root, file), target, targetStat];
    }
    return [relative(root, file), ...tuple(value)];
  };
  // Stats run concurrently; results keep the sorted walk order, so the identity is deterministic.
  const walk = async (directory: string): Promise<ReadonlyArray<readonly [string, unknown]>> => {
    const entries = await Promise.all(
      (await readdir(directory)).sort().map(async (name) => {
        const file = join(directory, name);
        const value = await lstat(file, { bigint: true });
        if (value.isDirectory()) return name.startsWith(".") || name === "node_modules" ? [] : walk(file);
        return value.isFile() || value.isSymbolicLink() ? [[file, await observe(file, value)] as const] : [];
      }),
    );
    return entries.flat();
  };
  for (const [file, observation] of await walk(root)) {
    paths.push(file);
    files.push(observation);
  }
  const dependencyFiles: unknown[] = [];
  const dependencies = join(root, "node_modules");
  const dependencyRoot = await lstat(dependencies, { bigint: true }).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (dependencyRoot?.isSymbolicLink()) dependencyFiles.push(await observe(dependencies, dependencyRoot));
  const names = dependencyRoot?.isDirectory() ? await readdir(dependencies) : [];
  const observeDependency = async (name: string): Promise<ReadonlyArray<unknown>> => {
    if (name.startsWith(".")) return [];
    if (name.startsWith("@") && (await lstat(join(dependencies, name))).isSymbolicLink())
      return [await observe(join(dependencies, name))];
    const packages = name.startsWith("@")
      ? (await readdir(join(dependencies, name))).sort().map((child) => join(name, child))
      : [name];
    const observations = await Promise.all(
      packages.map((pkg) =>
        observe(join(dependencies, pkg, "package.json")).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
          throw cause;
        }),
      ),
    );
    return observations.filter((observation) => observation !== undefined);
  };
  for (const observations of await Promise.all(names.sort().map(observeDependency)))
    dependencyFiles.push(...observations);
  const dependencyIdentity = digest(dependencyFiles);
  return {
    realpath: root,
    identity: digest([files, dependencyIdentity]),
    dependencies: dependencyIdentity,
    files: paths,
  };
};
