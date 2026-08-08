/**
 * Plugin package module-path resolution and plugin error constructors.
 *
 * `resolvePluginModulePath` is the containment check every plugin module load
 * goes through: a manifest-declared module path must resolve inside the plugin
 * package root both lexically and after realpath resolution, so a `..` segment
 * or a symlink cannot escape the package. The `pluginManifestError` /
 * `pluginLoadError` constructors are the tagged failures the loader and
 * discovery layers raise.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PluginLoadError, PluginManifestError } from "@lando/sdk/errors";

export const pluginManifestError = (message: string, cause: unknown): PluginManifestError =>
  new PluginManifestError({ message, issues: [String(cause)] });

export const pluginLoadError = (pluginName: string, message: string, cause?: unknown): PluginLoadError =>
  new PluginLoadError({
    message: cause === undefined ? message : `${message}: ${String(cause)}`,
    pluginName,
  });

export const packageRootPath = (packageRoot: string): string =>
  packageRoot.startsWith("file://") ? fileURLToPath(packageRoot) : packageRoot;

const realPathOrResolved = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));

export const resolvePluginModulePath = async (
  packageRoot: string,
  pluginName: string,
  modulePath: string,
): Promise<string> => {
  const root = resolve(packageRoot);
  const candidate = modulePath.startsWith("file://")
    ? fileURLToPath(modulePath)
    : isAbsolute(modulePath)
      ? modulePath
      : resolve(root, modulePath);
  const resolved = resolve(candidate);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw pluginLoadError(
      pluginName,
      `Plugin module ${modulePath} resolves outside the plugin package root ${root}.`,
    );
  }

  const realRoot = await realPathOrResolved(root);
  const realResolved = await realPathOrResolved(resolved);
  const realRelativePath = relative(realRoot, realResolved);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    throw pluginLoadError(
      pluginName,
      `Plugin module ${modulePath} resolves through symlink outside the plugin package root ${root}.`,
    );
  }

  return resolved;
};
