import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { InventoryFile, InventorySelector } from "./types.ts";

export interface ArchitectureInventory {
  files(selector: InventorySelector): Promise<ReadonlyArray<InventoryFile>>;
  manifestFiles(): Promise<ReadonlyArray<string>>;
}

interface InventorySnapshot {
  readonly files: ReadonlyArray<InventoryFile>;
  readonly pluginManifests: ReadonlyArray<string>;
}

const SOURCE_ROOTS = ["core/src", "sdk/src", "container-runtime/src", "plugins"] as const;
const WORKSPACE_MANIFESTS = [
  "core/package.json",
  "sdk/package.json",
  "container-runtime/package.json",
] as const;
const RUNTIME_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;
const TEST_SOURCE = ".test.";

const isMissingPath = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const toPosixRelative = (root: string, path: string): string => relative(root, path).replaceAll("\\", "/");

const walkRoot = async (root: string, directory: string): Promise<InventorySnapshot> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingPath(error)) return [];
    throw error;
  });

  const files: InventoryFile[] = [];
  const pluginManifests: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkRoot(root, absolutePath);
      files.push(...nested.files);
      pluginManifests.push(...nested.pluginManifests);
      continue;
    }
    const relativePath = toPosixRelative(root, absolutePath);
    files.push({ absolutePath, relativePath });
    if (/^plugins\/[^/]+\/package\.json$/.test(relativePath)) pluginManifests.push(absolutePath);
  }
  return { files, pluginManifests };
};

const scan = async (root: string): Promise<InventorySnapshot> => {
  const snapshots = await Promise.all(SOURCE_ROOTS.map((path) => walkRoot(root, resolve(root, path))));
  return {
    files: snapshots.flatMap(({ files }) => files),
    pluginManifests: snapshots.flatMap(({ pluginManifests }) => pluginManifests).sort(),
  };
};

const matchesSelector = (file: InventoryFile, selector: InventorySelector): boolean => {
  const path = file.relativePath;
  switch (selector) {
    case "core-and-plugin-sources":
      return (
        (path.startsWith("core/src/") || path.startsWith("plugins/")) &&
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts")
      );
    case "service-lando-services":
      return (
        path.startsWith("plugins/service-lando/src/services/") &&
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts")
      );
    case "workspace-runtime-sources":
      return (
        (path.startsWith("core/src/") ||
          path.startsWith("sdk/src/") ||
          path.startsWith("container-runtime/src/") ||
          /^plugins\/[^/]+\/src\//.test(path)) &&
        RUNTIME_EXTENSION.test(path) &&
        !path.includes(TEST_SOURCE)
      );
  }
};

export const createInventory = (rootInput: string): ArchitectureInventory => {
  const root = resolve(rootInput);
  const snapshot = scan(root);
  const selectors = new Map<InventorySelector, ReadonlyArray<InventoryFile>>();

  return {
    async files(selector) {
      const cached = selectors.get(selector);
      if (cached !== undefined) return cached;
      const result = (await snapshot).files
        .filter((file) => matchesSelector(file, selector))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      selectors.set(selector, result);
      return result;
    },
    async manifestFiles() {
      const { pluginManifests } = await snapshot;
      return [...WORKSPACE_MANIFESTS.map((path) => resolve(root, path)), ...pluginManifests];
    },
  };
};
