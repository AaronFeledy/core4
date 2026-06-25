import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { Data, Effect } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "../../cache/command-index-writer.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import type { InstalledPluginRegistryEntry } from "../../plugins/installed-registry.ts";
import { validatePluginManifest } from "./plugin-add.ts";

const RESERVED_PLUGIN_ROOT_ENTRIES = new Set([
  ".lando-linked.json",
  "node_modules",
  "package.json",
  "registry.json",
]);

export class PluginLinkConflictError extends Data.TaggedError("PluginLinkConflictError")<{
  readonly message: string;
  readonly commandId: "meta:plugin:link";
  readonly pluginName: string;
  readonly existingPath: string;
  readonly remediation: string;
}> {}

export interface PluginLinkOptions {
  readonly path?: string;
  readonly cwd?: string;
  readonly userDataRoot?: string;
  readonly pluginsRoot?: string;
  readonly cacheRoot?: string;
}

export interface PluginLinkResult {
  readonly pluginName: string;
  readonly linkedPath: string;
  readonly registryEntry: string;
}

export interface LinkedPluginEntry {
  readonly source: "linked";
  readonly linkedPath: string;
  readonly registryEntry: string;
  readonly previousRegistry?: InstalledPluginRegistryEntry;
}

export type LinkedPluginState = Record<string, LinkedPluginEntry>;

const linkedStatePath = (pluginsRoot: string): string => join(pluginsRoot, ".lando-linked.json");
const installedRegistryPath = (pluginsRoot: string): string => join(pluginsRoot, "registry.json");

export const readLinkedState = async (pluginsRoot: string): Promise<LinkedPluginState> => {
  const path = linkedStatePath(pluginsRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as LinkedPluginState;
};

export const writeLinkedState = async (pluginsRoot: string, state: LinkedPluginState): Promise<void> => {
  const path = linkedStatePath(pluginsRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, path);
};

const readInstalledRegistrySnapshot = async (pluginsRoot: string): Promise<string | undefined> => {
  const path = installedRegistryPath(pluginsRoot);
  if (!existsSync(path)) return undefined;
  return readFile(path, "utf8");
};

const writeInstalledRegistrySnapshot = async (pluginsRoot: string, snapshot: string): Promise<void> => {
  const path = installedRegistryPath(pluginsRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, snapshot);
  await rename(tmpPath, path);
};

const restoreInstalledRegistrySnapshot = async (
  pluginsRoot: string,
  snapshot: string | undefined,
): Promise<void> => {
  const path = installedRegistryPath(pluginsRoot);
  if (snapshot === undefined) {
    await rm(path, { force: true });
    return;
  }
  await writeInstalledRegistrySnapshot(pluginsRoot, snapshot);
};

const readInstalledRegistryForLink = async (pluginsRoot: string): Promise<Record<string, unknown>> => {
  const snapshot = await readInstalledRegistrySnapshot(pluginsRoot);
  if (snapshot === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
};

const recordLinkedPlugin = async (
  pluginsRoot: string,
  entry: InstalledPluginRegistryEntry,
): Promise<void> => {
  const registry = await readInstalledRegistryForLink(pluginsRoot);
  await writeInstalledRegistrySnapshot(
    pluginsRoot,
    `${JSON.stringify(
      {
        ...registry,
        [entry.name]: entry,
      },
      null,
      2,
    )}\n`,
  );
};

const loadRegistryEntry = async (
  pluginsRoot: string,
  pluginName: string,
): Promise<{ readonly source?: string; readonly path?: string } | undefined> => {
  const registry = await readInstalledRegistryForLink(pluginsRoot);
  const entry = registry[pluginName];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  return {
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
  };
};

const conflictError = (pluginName: string, existingPath: string): PluginLinkConflictError =>
  new PluginLinkConflictError({
    message: `Plugin ${pluginName} already exists at ${existingPath}; refusing to replace a non-linked registry entry.`,
    commandId: "meta:plugin:link",
    pluginName,
    existingPath,
    remediation:
      "Remove or unlink the existing plugin entry before linking this local authoring checkout. Automatic replacement is deferred to unlink/restore support.",
  });

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
  const registry = await loadRegistryEntry(pluginsRoot, pluginName);
  const linkedState = await readLinkedState(pluginsRoot);
  const registryIsLinked = registry?.source === "linked";
  const linkedStateMarksLinked = linkedState[pluginName]?.source === "linked";
  const existingLinked = registryIsLinked || linkedStateMarksLinked;
  if (existsSync(registryEntry)) {
    const stats = await lstat(registryEntry);
    if (!stats.isSymbolicLink()) throw conflictError(pluginName, registryEntry);
    if (!existingLinked) throw conflictError(pluginName, registryEntry);
    return { previousSymlinkTarget: await readlink(registryEntry) };
  }
  if (registry !== undefined && !registryIsLinked)
    throw conflictError(pluginName, registry.path ?? registryEntry);
  return {};
};

export const pluginLink = (
  options: PluginLinkOptions = {},
): Effect.Effect<
  PluginLinkResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError | PluginLinkConflictError,
  ConfigService
> =>
  Effect.gen(function* () {
    let userDataRoot = options.userDataRoot;
    if (userDataRoot === undefined) {
      const configService = yield* ConfigService;
      userDataRoot = yield* configService.get("userDataRoot");
      if (userDataRoot === undefined) {
        return yield* Effect.fail(
          new NotImplementedError({
            message: "userDataRoot is not configured.",
            commandId: "meta:plugin:link",
            remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
          }),
        );
      }
    }
    const cwd = options.cwd ?? process.cwd();
    const linkedPath = resolve(cwd, options.path ?? ".");
    const pluginsRoot = options.pluginsRoot ?? makeLandoPaths({ userDataRoot }).pluginsDir;
    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(linkedPath),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Plugin manifest validation failed in ${linkedPath}.`,
              issues: [String(cause)],
            }),
    });
    const registryEntry = resolve(pluginsRoot, manifest.name);
    // Refuse before any filesystem mutation if the manifest name resolves
    // outside the plugins root (PluginName is an unvalidated branded string,
    // so a hostile package.json could otherwise cause `mkdir` to create
    // parent directories outside <userDataRoot>/plugins/ before the
    // collision/containment check inside `prepareRegistryEntry` fires).
    yield* Effect.try({
      try: () => assertInsidePluginsRoot(pluginsRoot, registryEntry, manifest.name),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Plugin ${manifest.name} link target resolves outside ${pluginsRoot}.`,
              pluginName: manifest.name,
              issues: [String(cause)],
            }),
    });

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(registryEntry), { recursive: true });
        const prepared = await prepareRegistryEntry(pluginsRoot, manifest.name, registryEntry);
        const previousState = await readLinkedState(pluginsRoot);
        const previousRegistry = await readInstalledRegistrySnapshot(pluginsRoot);
        let linkedStateWritten = false;
        await replaceRegistrySymlink(registryEntry, linkedPath);
        try {
          await writeLinkedState(pluginsRoot, {
            ...previousState,
            [manifest.name]: { source: "linked", linkedPath, registryEntry },
          });
          linkedStateWritten = true;
          await recordLinkedPlugin(pluginsRoot, {
            name: manifest.name,
            version: manifest.version,
            path: registryEntry,
            source: "linked",
            linkedPath,
          });
        } catch (cause) {
          await safeRollback("registry", () =>
            restoreInstalledRegistrySnapshot(pluginsRoot, previousRegistry),
          );
          if (linkedStateWritten)
            await safeRollback("linked-state", () => writeLinkedState(pluginsRoot, previousState));
          await safeRollback("symlink", () =>
            restoreRegistrySymlink(registryEntry, prepared.previousSymlinkTarget),
          );
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof PluginLinkConflictError || cause instanceof PluginManifestError
          ? cause
          : new NotImplementedError({
              message: `Plugin link failed for ${manifest.name}: ${String(cause)}`,
              commandId: "meta:plugin:link",
              remediation: "Check the plugin authoring path and retry.",
            }),
    });

    yield* invalidatePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    return { pluginName: manifest.name, linkedPath, registryEntry };
  });

export const renderPluginLinkResult = (result: PluginLinkResult): string =>
  [
    `plugin-link: ${result.pluginName}`,
    `linked-path: ${result.linkedPath}`,
    `registry-entry: ${result.registryEntry}`,
    "result: linked",
  ].join("\n");
