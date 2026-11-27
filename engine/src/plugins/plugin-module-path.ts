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

import { isPathWithin } from "@lando/paths";
import { PluginLoadError, PluginManifestError } from "@lando/sdk/errors";
import { validationIssuesFromCause } from "@lando/sdk/schema";

export const pluginManifestError = (
  message: string,
  cause: unknown,
  remediation: string,
): PluginManifestError =>
  new PluginManifestError({
    message,
    issues: validationIssuesFromCause(cause, { fallback: String(cause) }),
    remediation,
  });

export const pluginLoadError = (
  pluginName: string,
  message: string,
  cause: unknown | undefined,
  remediation: string,
): PluginLoadError =>
  new PluginLoadError({
    message: cause === undefined ? message : `${message}: ${String(cause)}`,
    pluginName,
    remediation,
  });

export const packageRootPath = (packageRoot: string): string =>
  packageRoot.startsWith("file://") ? fileURLToPath(packageRoot) : packageRoot;

const realPathOrResolved = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));

export interface PluginPackageRoot {
  readonly authored: string;
  readonly canonical: string;
}

export const pinPluginPackageRoot = async (path: string): Promise<PluginPackageRoot> => {
  const authored = resolve(packageRootPath(path));
  try {
    return { authored, canonical: await realpath(authored) };
  } catch (cause) {
    throw pluginManifestError(
      `Plugin package root cannot be resolved: ${authored}`,
      cause,
      `Make the package directory at ${authored} readable or repair its registration.`,
    );
  }
};

export const resolvePluginModulePath = async (
  { authored: root, canonical }: PluginPackageRoot,
  pluginName: string,
  modulePath: string,
): Promise<string> => {
  const candidate = modulePath.startsWith("file://")
    ? fileURLToPath(modulePath)
    : isAbsolute(modulePath)
      ? modulePath
      : resolve(root, modulePath);
  const resolved = resolve(candidate);
  if (!isPathWithin(root, resolved)) {
    throw pluginLoadError(
      pluginName,
      `Plugin module ${modulePath} resolves outside the plugin package root ${root}.`,
      undefined,
      `Point the module path at a file inside the plugin package root ${root}.`,
    );
  }

  // The registration's lexical spelling is not followed again after admission.
  const realResolved = await realPathOrResolved(resolve(canonical, relative(root, resolved)));
  if (!isPathWithin(canonical, realResolved)) {
    throw pluginLoadError(
      pluginName,
      `Plugin module ${modulePath} resolves through symlink outside the plugin package root ${root}.`,
      undefined,
      `Remove the escaping symlink or point the module path inside the plugin package root ${root}.`,
    );
  }

  return realResolved;
};
