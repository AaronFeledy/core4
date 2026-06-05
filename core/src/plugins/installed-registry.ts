import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Either, Schema } from "effect";

export interface InstalledPluginRegistryEntry {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

export type InstalledPluginRegistry = Readonly<Record<string, InstalledPluginRegistryEntry>>;

const InstalledPluginRegistryEntryShape = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  path: Schema.String,
});

const InstalledPluginRegistryShape = Schema.Record({
  key: Schema.String,
  value: InstalledPluginRegistryEntryShape,
});

const installedPluginRegistryPath = (pluginsRoot: string): string => join(pluginsRoot, "registry.json");

export const readInstalledPluginRegistry = async (pluginsRoot: string): Promise<InstalledPluginRegistry> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  const decoded = Schema.decodeUnknownEither(InstalledPluginRegistryShape)(parsed, {
    onExcessProperty: "error",
  });
  return Either.isRight(decoded) ? decoded.right : {};
};

const writeInstalledPluginRegistry = async (
  pluginsRoot: string,
  registry: InstalledPluginRegistry,
): Promise<void> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(tmpPath, path);
};

export const recordInstalledPlugin = async (
  pluginsRoot: string,
  entry: InstalledPluginRegistryEntry,
): Promise<void> => {
  const registry = await readInstalledPluginRegistry(pluginsRoot);
  await writeInstalledPluginRegistry(pluginsRoot, {
    ...registry,
    [entry.name]: entry,
  });
};

export const removeInstalledPlugin = async (pluginsRoot: string, name: string): Promise<void> => {
  const registry = await readInstalledPluginRegistry(pluginsRoot);
  if (!Object.hasOwn(registry, name)) return;
  const next = { ...registry };
  delete next[name];
  await writeInstalledPluginRegistry(pluginsRoot, next);
};
