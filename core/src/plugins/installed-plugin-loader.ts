/**
 * Installed-plugin package loading and manifest normalization.
 *
 * `loadInstalledPlugin` reads a plugin package's `package.json` (or its
 * `landoPlugin` field), strict-decodes the {@link PluginManifest}, normalizes
 * every contribution module path to an in-package `file://` URL, and imports the
 * optional entry module. `normalizeExternalContributionModules` performs the
 * per-contribution path rewriting and duplicate-id checks so downstream service
 * wiring receives only validated, containment-checked module URLs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Either, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";

import {
  packageRootPath,
  pluginLoadError,
  pluginManifestError,
  resolvePluginModulePath,
} from "./plugin-module-path.ts";

export interface ExternalPluginModule {
  readonly [key: string]: unknown;
}

const loadExternalPluginEntry = async (
  packageRoot: string,
  manifest: PluginManifest,
): Promise<ExternalPluginModule | undefined> => {
  if (manifest.entry === undefined) return undefined;
  const entryPath = await resolvePluginModulePath(packageRoot, String(manifest.name), manifest.entry);
  try {
    return (await import(pathToFileURL(entryPath).href)) as ExternalPluginModule;
  } catch (cause) {
    throw pluginLoadError(String(manifest.name), `Failed to import plugin entry ${manifest.entry}`, cause);
  }
};

const normalizeExternalContributionModules = async (
  packageRoot: string,
  manifest: PluginManifest,
): Promise<PluginManifest> => {
  const globalServices = manifest.contributes?.globalServices;
  const downloaders = manifest.contributes?.downloaders;
  const httpClients = manifest.contributes?.httpClients;
  const interactionServices = manifest.contributes?.interactionServices;
  const proxyServices = manifest.contributes?.proxyServices;
  const remoteSources = manifest.contributes?.remoteSources;
  const datasets = manifest.contributes?.datasets;
  const tunnelServices = manifest.contributes?.tunnelServices;
  const rendererPanels = manifest.contributes?.rendererPanels;
  const subscribers = manifest.subscribers;
  if (
    globalServices === undefined &&
    downloaders === undefined &&
    httpClients === undefined &&
    interactionServices === undefined &&
    proxyServices === undefined &&
    remoteSources === undefined &&
    datasets === undefined &&
    tunnelServices === undefined &&
    rendererPanels === undefined &&
    subscribers === undefined
  ) {
    return manifest;
  }

  const normalizeContributionModulePath = async (modulePath: string): Promise<string> => {
    const resolved = await resolvePluginModulePath(packageRoot, String(manifest.name), modulePath);
    return pathToFileURL(resolved).href;
  };

  const normalizeManifestModulePath = async (modulePath: string, kind: string): Promise<string> => {
    try {
      return await normalizeContributionModulePath(modulePath);
    } catch (cause) {
      if (cause instanceof PluginLoadError) {
        throw pluginManifestError(
          `${kind} module path escapes the plugin package root: ${modulePath}`,
          cause,
        );
      }
      throw cause;
    }
  };

  if (rendererPanels !== undefined) {
    const seenIds = new Set<string>();
    for (const panel of rendererPanels) {
      if (seenIds.has(panel.id)) {
        throw pluginManifestError(
          `Duplicate rendererPanels id "${panel.id}" in plugin ${String(manifest.name)}`,
          panel.id,
        );
      }
      seenIds.add(panel.id);
    }
  }

  if (subscribers !== undefined) {
    const seenSubscriberIds = new Set<string>();
    for (const subscriber of subscribers) {
      if (seenSubscriberIds.has(subscriber.id)) {
        throw pluginManifestError(
          `Duplicate subscribers id "${subscriber.id}" in plugin ${String(manifest.name)}`,
          subscriber.id,
        );
      }
      seenSubscriberIds.add(subscriber.id);
    }
  }

  const normalizedGlobalServices =
    globalServices === undefined
      ? undefined
      : await Promise.all(
          globalServices.map(async (contribution) => {
            if (contribution.module === undefined) return contribution;
            return { ...contribution, module: await normalizeContributionModulePath(contribution.module) };
          }),
        );
  const normalizedDownloaders =
    downloaders === undefined
      ? undefined
      : await Promise.all(
          downloaders.map(async (contribution) => {
            if (contribution.module === undefined) return contribution;
            return { ...contribution, module: await normalizeContributionModulePath(contribution.module) };
          }),
        );
  const normalizedHttpClients =
    httpClients === undefined
      ? undefined
      : await Promise.all(
          httpClients.map(async (contribution) => {
            if (contribution.module === undefined) return contribution;
            return { ...contribution, module: await normalizeContributionModulePath(contribution.module) };
          }),
        );
  const normalizedInteractionServices =
    interactionServices === undefined
      ? undefined
      : await Promise.all(
          interactionServices.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );
  const normalizedProxyServices =
    proxyServices === undefined
      ? undefined
      : await Promise.all(
          proxyServices.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );
  const normalizedRemoteSources =
    remoteSources === undefined
      ? undefined
      : await Promise.all(
          remoteSources.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );
  const normalizedDatasets =
    datasets === undefined
      ? undefined
      : await Promise.all(
          datasets.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );
  const normalizedTunnelServices =
    tunnelServices === undefined
      ? undefined
      : await Promise.all(
          tunnelServices.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );
  const normalizedRendererPanels =
    rendererPanels === undefined
      ? undefined
      : await Promise.all(
          rendererPanels.map(async (contribution) => ({
            ...contribution,
            module: await normalizeManifestModulePath(contribution.module, "rendererPanels"),
          })),
        );
  const normalizedSubscribers =
    subscribers === undefined
      ? undefined
      : await Promise.all(
          subscribers.map(async (contribution) => ({
            ...contribution,
            module: await normalizeManifestModulePath(contribution.module, "subscribers"),
          })),
        );

  return {
    ...manifest,
    ...(normalizedSubscribers === undefined ? {} : { subscribers: normalizedSubscribers }),
    contributes: {
      ...manifest.contributes,
      ...(normalizedGlobalServices === undefined ? {} : { globalServices: normalizedGlobalServices }),
      ...(normalizedDownloaders === undefined ? {} : { downloaders: normalizedDownloaders }),
      ...(normalizedHttpClients === undefined ? {} : { httpClients: normalizedHttpClients }),
      ...(normalizedInteractionServices === undefined
        ? {}
        : { interactionServices: normalizedInteractionServices }),
      ...(normalizedProxyServices === undefined ? {} : { proxyServices: normalizedProxyServices }),
      ...(normalizedRemoteSources === undefined ? {} : { remoteSources: normalizedRemoteSources }),
      ...(normalizedDatasets === undefined ? {} : { datasets: normalizedDatasets }),
      ...(normalizedTunnelServices === undefined ? {} : { tunnelServices: normalizedTunnelServices }),
      ...(normalizedRendererPanels === undefined ? {} : { rendererPanels: normalizedRendererPanels }),
    },
  };
};

export const loadInstalledPlugin = async (
  packageRootInput: string,
): Promise<{ readonly manifest: PluginManifest; readonly module?: ExternalPluginModule }> => {
  const packageRoot = packageRootPath(packageRootInput);
  const packageJsonPath = join(packageRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (cause) {
    throw pluginManifestError(`Plugin package.json is invalid: ${packageJsonPath}`, cause);
  }
  const candidate = (parsed as { landoPlugin?: unknown }).landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownEither(PluginManifest)(candidate, { onExcessProperty: "error" });
  if (Either.isLeft(decoded)) {
    throw pluginManifestError(`Plugin manifest validation failed: ${packageJsonPath}`, decoded.left);
  }
  const manifest = await normalizeExternalContributionModules(packageRoot, decoded.right);
  const module = await loadExternalPluginEntry(packageRoot, manifest);
  return { manifest, ...(module === undefined ? {} : { module }) };
};
