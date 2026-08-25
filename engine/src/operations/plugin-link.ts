import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { PluginManifestError } from "@lando/sdk/errors";

import {
  readInstalledPluginRegistry,
  readInstalledPluginRegistryEntry,
  readInstalledPluginRegistryFileSnapshot,
  readRawInstalledPluginRegistryEntries,
  recordInstalledPlugin,
  removeInstalledPlugin,
  replaceInstalledPluginRegistry,
  restoreInstalledPluginRegistryFileSnapshot,
} from "../plugins/installed-registry.ts";
import { readLinkedState, writeLinkedState } from "../plugins/linked-state.ts";

const RESERVED_PLUGIN_ROOT_ENTRIES = new Set([
  ".lando-linked.json",
  "node_modules",
  "package.json",
  "registry.json",
]);

const PLUGIN_LINK_CONFLICT = "PLUGIN_LINK_CONFLICT";
const PLUGIN_UNLINK_NOT_LINKED = "PLUGIN_UNLINK_NOT_LINKED";

class PluginLinkConflictCauseError extends Error {
  readonly code = PLUGIN_LINK_CONFLICT;
  readonly pluginName: string;
  readonly existingPath: string;

  constructor(pluginName: string, existingPath: string) {
    super(
      `Plugin ${pluginName} already exists at ${existingPath}; refusing to replace a non-linked registry entry.`,
    );
    this.name = "PluginLinkConflict";
    this.pluginName = pluginName;
    this.existingPath = existingPath;
  }
}

class PluginUnlinkNotLinkedCauseError extends Error {
  readonly code = PLUGIN_UNLINK_NOT_LINKED;
  readonly pluginName: string;

  constructor(pluginName: string) {
    super(`Plugin ${pluginName} is not linked; nothing to unlink.`);
    this.name = "PluginUnlinkNotLinked";
    this.pluginName = pluginName;
  }
}

export const isPluginLinkConflictCause = (cause: unknown): cause is PluginLinkConflictCauseError =>
  cause instanceof PluginLinkConflictCauseError;

export const isPluginUnlinkNotLinkedCause = (cause: unknown): cause is PluginUnlinkNotLinkedCauseError =>
  cause instanceof PluginUnlinkNotLinkedCauseError;

export const assertInsidePluginsRoot = (pluginsRoot: string, target: string, pluginName: string): void => {
  const rel = relative(pluginsRoot, target);
  if (rel === "" || rel.startsWith("..") || resolve(pluginsRoot, rel) !== target) {
    throw new PluginManifestError({
      message: `Plugin ${pluginName} link target resolves outside ${pluginsRoot}.`,
      pluginName,
      issues: [`refusing to write ${target}`],
    });
  }
  const [firstSegment] = rel.split(/[\\/]/u);
  if (firstSegment !== undefined && RESERVED_PLUGIN_ROOT_ENTRIES.has(firstSegment)) {
    throw new PluginManifestError({
      message: `Plugin ${pluginName} link target uses reserved plugins root entry ${firstSegment}.`,
      pluginName,
      issues: [`refusing to write ${target}`],
    });
  }
};

const removeRegistrySymlink = async (path: string): Promise<void> => {
  const stats = await lstat(path).catch(() => undefined);
  if (stats?.isSymbolicLink() === true) await rm(path, { force: true });
};

const registrySymlinkTmpPath = (registryEntry: string): string =>
  `${registryEntry}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const replaceRegistrySymlink = async (registryEntry: string, target: string): Promise<void> => {
  const tmpPath = registrySymlinkTmpPath(registryEntry);
  await symlink(target, tmpPath, "dir");
  try {
    await rename(tmpPath, registryEntry);
  } catch (cause) {
    await removeRegistrySymlink(tmpPath);
    throw cause;
  }
};

const restoreRegistrySymlink = async (
  registryEntry: string,
  previousTarget: string | undefined,
): Promise<void> => {
  if (previousTarget === undefined) {
    await removeRegistrySymlink(registryEntry);
    return;
  }
  await replaceRegistrySymlink(registryEntry, previousTarget);
};

const safeRollback = async (label: string, op: () => Promise<void>): Promise<void> => {
  try {
    await op();
  } catch (rollbackCause) {
    process.emitWarning(`plugin-link: rollback step "${label}" failed: ${String(rollbackCause)}`);
  }
};

const prepareRegistryEntry = async (
  pluginsRoot: string,
  pluginName: string,
  registryEntry: string,
): Promise<{ readonly previousSymlinkTarget?: string }> => {
  assertInsidePluginsRoot(pluginsRoot, registryEntry, pluginName);
  const registry = await readInstalledPluginRegistryEntry(pluginsRoot, pluginName);
  const linkedState = await readLinkedState(pluginsRoot);
  const registryIsLinked = registry?.source === "linked";
  const linkedStateMarksLinked = linkedState[pluginName]?.source === "linked";
  const existingLinked = registryIsLinked || linkedStateMarksLinked;
  if (existsSync(registryEntry)) {
    const stats = await lstat(registryEntry);
    if (!stats.isSymbolicLink()) throw new PluginLinkConflictCauseError(pluginName, registryEntry);
    if (!existingLinked) throw new PluginLinkConflictCauseError(pluginName, registryEntry);
    return { previousSymlinkTarget: await readlink(registryEntry) };
  }
  if (registry !== undefined && !registryIsLinked)
    throw new PluginLinkConflictCauseError(pluginName, registry.path ?? registryEntry);
  return {};
};

export interface ApplyPluginLinkInput {
  readonly pluginsRoot: string;
  readonly linkedPath: string;
  readonly pluginName: string;
  readonly version: string;
}

export interface ApplyPluginLinkResult {
  readonly pluginName: string;
  readonly linkedPath: string;
  readonly registryEntry: string;
}

export const applyPluginLink = async (input: ApplyPluginLinkInput): Promise<ApplyPluginLinkResult> => {
  const { pluginsRoot, linkedPath, pluginName, version } = input;
  const registryEntry = resolve(pluginsRoot, pluginName);
  assertInsidePluginsRoot(pluginsRoot, registryEntry, pluginName);
  await mkdir(dirname(registryEntry), { recursive: true });
  const prepared = await prepareRegistryEntry(pluginsRoot, pluginName, registryEntry);
  const previousState = await readLinkedState(pluginsRoot);
  const previousRegistry = await readInstalledPluginRegistryFileSnapshot(pluginsRoot);
  let linkedStateWritten = false;
  await replaceRegistrySymlink(registryEntry, linkedPath);
  try {
    await writeLinkedState(pluginsRoot, {
      ...previousState,
      [pluginName]: { source: "linked", linkedPath, registryEntry },
    });
    linkedStateWritten = true;
    const registry = await readRawInstalledPluginRegistryEntries(pluginsRoot);
    await replaceInstalledPluginRegistry(pluginsRoot, {
      ...registry,
      [pluginName]: {
        name: pluginName,
        version,
        path: registryEntry,
        source: "linked",
        linkedPath,
      },
    });
  } catch (cause) {
    await safeRollback("registry", () =>
      restoreInstalledPluginRegistryFileSnapshot(pluginsRoot, previousRegistry),
    );
    if (linkedStateWritten)
      await safeRollback("linked-state", () => writeLinkedState(pluginsRoot, previousState));
    await safeRollback("symlink", () =>
      restoreRegistrySymlink(registryEntry, prepared.previousSymlinkTarget),
    );
    throw cause;
  }
  return { pluginName, linkedPath, registryEntry };
};

export interface RevertPluginLinkInput {
  readonly pluginsRoot: string;
  readonly name: string;
}

export interface RevertPluginLinkResult {
  readonly action: "restored" | "removed";
  readonly restoredPath?: string;
  readonly registryEntry: string;
}

export const revertPluginLink = async (input: RevertPluginLinkInput): Promise<RevertPluginLinkResult> => {
  const { pluginsRoot, name } = input;
  const registry = await readInstalledPluginRegistry(pluginsRoot);
  const registryEntry = resolve(pluginsRoot, name);
  assertInsidePluginsRoot(pluginsRoot, registryEntry, name);
  const stats = await lstat(registryEntry).catch(() => undefined);
  const isLinkedSymlink = stats?.isSymbolicLink() === true;
  const lockedState = await readLinkedState(pluginsRoot);
  const lockedLinked = lockedState[name]?.source === "linked";
  const registryMarksLinked = registry[name]?.source === "linked";
  const registryEntryExists = stats !== undefined;

  if (registryEntryExists && !isLinkedSymlink) throw new PluginUnlinkNotLinkedCauseError(name);

  const isLinked = isLinkedSymlink || registryMarksLinked || lockedLinked;
  if (!isLinked) throw new PluginUnlinkNotLinkedCauseError(name);

  const previousRegistry = lockedState[name]?.previousRegistry;

  const dropLockedEntry = async (): Promise<void> => {
    const state = await readLinkedState(pluginsRoot);
    if (state[name] === undefined) return;
    const next = { ...state };
    delete next[name];
    await writeLinkedState(pluginsRoot, next);
  };

  if (previousRegistry !== undefined) {
    await recordInstalledPlugin(pluginsRoot, previousRegistry);
    await removeRegistrySymlink(registryEntry);
    await dropLockedEntry();
    return {
      action: "restored",
      restoredPath: previousRegistry.path,
      registryEntry,
    };
  }

  await removeRegistrySymlink(registryEntry);
  await removeInstalledPlugin(pluginsRoot, name);
  await dropLockedEntry();
  return { action: "removed", registryEntry };
};
