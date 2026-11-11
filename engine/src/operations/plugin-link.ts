import { existsSync } from "node:fs";
import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { PluginManifestError, isErrnoCode } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { Effect } from "effect";

import { mutateInstalledPluginRegistry } from "../plugins/installed-registry.ts";
import {
  PluginLinkConflictCauseError,
  PluginUnlinkNotLinkedCauseError,
} from "../plugins/registry-transitions.ts";

const RESERVED_PLUGIN_ROOT_ENTRIES = new Set([
  ".lando-plugin-mutation",
  ".lando-plugin-mutation.lock",
  "node_modules",
  "package.json",
  "registry.json",
]);

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
      issues: [{ path: [], message: `refusing to write ${target}` }],
      remediation: "Set the manifest name to an npm package name without parent-directory segments.",
    });
  }
  const [firstSegment] = rel.split(/[\\/]/u);
  if (firstSegment !== undefined && RESERVED_PLUGIN_ROOT_ENTRIES.has(firstSegment)) {
    throw new PluginManifestError({
      message: `Plugin ${pluginName} link target uses reserved plugins root entry ${firstSegment}.`,
      pluginName,
      issues: [{ path: [], message: `refusing to write ${target}` }],
      remediation: "Choose a plugin package name that does not use a reserved plugins root entry.",
    });
  }
};

const removeRegistrySymlink = async (path: string): Promise<void> => {
  const stats = await lstat(path).catch((cause: unknown) => {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  });
  if (stats?.isSymbolicLink() === true) await rm(path, { force: true });
};

const registrySymlinkTmpPath = (registryEntry: string): string =>
  `${registryEntry}.tmp-${process.pid}-${crypto.randomUUID()}`;

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
  pluginName: string,
  registryEntry: string,
): Promise<{ readonly previousSymlinkTarget?: string }> => {
  const stats = await lstat(registryEntry).catch((cause: unknown) => {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  });
  if (stats !== undefined) {
    if (!stats.isSymbolicLink()) throw new PluginLinkConflictCauseError(pluginName, registryEntry);
    return { previousSymlinkTarget: await readlink(registryEntry) };
  }
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

const defaultIo = { writeFileAtomic };

export const applyPluginLink = async (
  input: ApplyPluginLinkInput,
  io: typeof defaultIo = defaultIo,
): Promise<ApplyPluginLinkResult> => {
  const { pluginsRoot, linkedPath, pluginName, version } = input;
  const registryEntry = resolve(pluginsRoot, pluginName);
  assertInsidePluginsRoot(pluginsRoot, registryEntry, pluginName);
  return Effect.runPromise(
    mutateInstalledPluginRegistry(
      {
        pluginsRoot,
        mutation: {
          operation: "link",
          entry: { name: pluginName, version, path: registryEntry, linkedPath },
        },
      },
      (commit) =>
        Effect.promise(async () => {
          const prepared = await prepareRegistryEntry(pluginName, registryEntry);
          await mkdir(dirname(registryEntry), { recursive: true });
          await replaceRegistrySymlink(registryEntry, linkedPath);
          try {
            await commit();
          } catch (cause) {
            await safeRollback("symlink", () =>
              restoreRegistrySymlink(registryEntry, prepared.previousSymlinkTarget),
            );
            throw cause;
          }
          return { pluginName, linkedPath, registryEntry };
        }),
      io,
    ),
  );
};

export interface RevertPluginLinkInput {
  readonly pluginsRoot: string;
  readonly name: string;
}

export interface RevertPluginLinkResult {
  readonly action: "removed";
  readonly registryEntry: string;
}

export const revertPluginLink = async (
  input: RevertPluginLinkInput,
  io: typeof defaultIo = defaultIo,
): Promise<RevertPluginLinkResult> => {
  const { pluginsRoot, name } = input;
  const registryEntry = resolve(pluginsRoot, name);
  assertInsidePluginsRoot(pluginsRoot, registryEntry, name);
  if (!existsSync(pluginsRoot)) throw new PluginUnlinkNotLinkedCauseError(name);
  return Effect.runPromise(
    mutateInstalledPluginRegistry(
      { pluginsRoot, mutation: { operation: "unlink", name } },
      (commit) =>
        Effect.promise(async () => {
          const stats = await lstat(registryEntry).catch((cause: unknown) => {
            if (isErrnoCode(cause, "ENOENT")) return undefined;
            throw cause;
          });
          if (stats !== undefined && !stats.isSymbolicLink()) throw new PluginUnlinkNotLinkedCauseError(name);
          const previousTarget = stats === undefined ? undefined : await readlink(registryEntry);
          await removeRegistrySymlink(registryEntry);
          try {
            await commit();
          } catch (cause) {
            await safeRollback("symlink", () => restoreRegistrySymlink(registryEntry, previousTarget));
            throw cause;
          }
          return { action: "removed" as const, registryEntry };
        }),
      io,
    ),
  );
};
