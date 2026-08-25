import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export interface InstalledPluginRegistryFailure {
  readonly pluginId: string;
  readonly pluginPath: string;
  readonly metadataPath: string;
  readonly cause: unknown;
}

export interface InstalledPluginRegistryInspection {
  readonly registry: InstalledPluginRegistry;
  readonly failures: ReadonlyArray<InstalledPluginRegistryFailure>;
}

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

export const readRawInstalledPluginRegistryEntries = async (
  pluginsRoot: string,
): Promise<RawInstalledPluginRegistry> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  return parsed;
};

export const readInstalledPluginRegistry = async (pluginsRoot: string): Promise<InstalledPluginRegistry> => {
  const inspection = await inspectInstalledPluginRegistry(pluginsRoot);
  return inspection.registry;
};

export const inspectInstalledPluginRegistry = async (
  pluginsRoot: string,
): Promise<InstalledPluginRegistryInspection> => {
  const metadataPath = installedPluginRegistryPath(pluginsRoot);
  let raw: RawInstalledPluginRegistry;
  try {
    raw = await readRawInstalledPluginRegistry(pluginsRoot);
  } catch (cause) {
    return {
      registry: {},
      failures: [{ pluginId: "registry", pluginPath: pluginsRoot, metadataPath, cause }],
    };
  }
  const registry: Record<string, InstalledPluginRegistryEntry> = {};
  const failures: InstalledPluginRegistryFailure[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const decoded = Schema.decodeUnknownEither(InstalledPluginRegistryEntryShape)(entry, {
      onExcessProperty: "error",
    });
    if (Either.isRight(decoded)) {
      registry[name] = decoded.right;
    } else {
      failures.push({
        pluginId: name,
        pluginPath: isRecord(entry) && typeof entry.path === "string" ? entry.path : pluginsRoot,
        metadataPath,
        cause: decoded.left,
      });
    }
  }
  return { registry, failures };
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

export const readInstalledPluginRegistryFileSnapshot = async (
  pluginsRoot: string,
): Promise<string | undefined> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  if (!existsSync(path)) return undefined;
  return readFile(path, "utf8");
};

export const restoreInstalledPluginRegistryFileSnapshot = async (
  pluginsRoot: string,
  snapshot: string | undefined,
): Promise<void> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  if (snapshot === undefined) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, snapshot);
  await rename(tmpPath, path);
};

export const replaceInstalledPluginRegistry = async (
  pluginsRoot: string,
  entries: RawInstalledPluginRegistry,
): Promise<void> => {
  await writeInstalledPluginRegistry(pluginsRoot, entries);
};

export const readInstalledPluginRegistryEntry = async (
  pluginsRoot: string,
  name: string,
): Promise<{ readonly source?: string; readonly path?: string } | undefined> => {
  const registry = await readRawInstalledPluginRegistryEntries(pluginsRoot);
  const entry = registry[name];
  if (!isRecord(entry)) return undefined;
  return {
    ...(typeof entry.source === "string" ? { source: entry.source } : {}),
    ...(typeof entry.path === "string" ? { path: entry.path } : {}),
  };
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
