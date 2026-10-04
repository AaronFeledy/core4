import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@lando/state-store/atomic";

import { Predicate, Result, Schema } from "effect";

export interface InstalledPluginRegistryEntry {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly requestedSelector?: string | undefined;
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
  requestedSelector: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["installed", "linked"])),
  linkedPath: Schema.optionalKey(Schema.String),
});

const installedPluginRegistryPath = (pluginsRoot: string): string => join(pluginsRoot, "registry.json");

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
  if (!Predicate.isObject(parsed)) throw corruptRegistryError(path, "registry root is not an object");
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
  if (!Predicate.isObject(parsed)) return {};
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
    const decoded = Schema.decodeUnknownResult(InstalledPluginRegistryEntryShape)(entry, {
      onExcessProperty: "error",
    });
    if (Result.isSuccess(decoded)) {
      registry[name] = decoded.success;
    } else {
      failures.push({
        pluginId: name,
        pluginPath: Predicate.isObject(entry) && typeof entry.path === "string" ? entry.path : pluginsRoot,
        metadataPath,
        cause: decoded.failure,
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
  await writeFileAtomic(path, `${JSON.stringify(registry, null, 2)}\n`);
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
  await writeFileAtomic(path, snapshot);
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
  if (!Predicate.isObject(entry)) return undefined;
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
