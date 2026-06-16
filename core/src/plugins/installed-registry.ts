import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Either, Schema } from "effect";

export interface InstalledPluginRegistryEntry {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly source?: "installed" | "linked" | undefined;
  readonly linkedPath?: string | undefined;
}

export type InstalledPluginRegistry = Readonly<Record<string, InstalledPluginRegistryEntry>>;

type RawInstalledPluginRegistry = Record<string, unknown>;

const InstalledPluginRegistryEntryShape = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  path: Schema.String,
  source: Schema.optional(Schema.Literal("installed", "linked")),
  linkedPath: Schema.optional(Schema.String),
});

const installedPluginRegistryPath = (pluginsRoot: string): string => join(pluginsRoot, "registry.json");

const isRecord = (value: unknown): value is RawInstalledPluginRegistry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const corruptRegistryError = (path: string, cause: unknown): Error =>
  new Error(`Installed plugin registry is corrupt: ${path}. ${String(cause)}`);

const readRawInstalledPluginRegistry = async (pluginsRoot: string): Promise<RawInstalledPluginRegistry> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw corruptRegistryError(path, cause);
  }
  if (!isRecord(parsed)) throw corruptRegistryError(path, "registry root is not an object");
  return parsed;
};

export const readInstalledPluginRegistry = async (pluginsRoot: string): Promise<InstalledPluginRegistry> => {
  const raw = await readRawInstalledPluginRegistry(pluginsRoot).catch(() => ({}));
  const registry: Record<string, InstalledPluginRegistryEntry> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const decoded = Schema.decodeUnknownEither(InstalledPluginRegistryEntryShape)(entry, {
      onExcessProperty: "error",
    });
    if (Either.isRight(decoded)) registry[name] = decoded.right;
  }
  return registry;
};

const writeInstalledPluginRegistry = async (
  pluginsRoot: string,
  registry: RawInstalledPluginRegistry,
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
  const registry = await readRawInstalledPluginRegistry(pluginsRoot);
  await writeInstalledPluginRegistry(pluginsRoot, {
    ...registry,
    [entry.name]: entry,
  });
};

export const removeInstalledPlugin = async (pluginsRoot: string, name: string): Promise<void> => {
  const registry = await readRawInstalledPluginRegistry(pluginsRoot);
  if (!Object.hasOwn(registry, name)) return;
  const next = { ...registry };
  delete next[name];
  await writeInstalledPluginRegistry(pluginsRoot, next);
};
