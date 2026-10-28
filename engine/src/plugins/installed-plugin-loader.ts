import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Result, Schema } from "effect";

import { importAuthorModule } from "@lando/landofile/author-modules";
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

// Bun caches native file imports by path for the life of the process. Share
// first acquisition, including its source digest, across concurrent callers.
const nativeEntryModules = new Map<
  string,
  Promise<{ readonly module: ExternalPluginModule; readonly sourceRevision: string }>
>();

const loadExternalPluginEntry = async (
  packageRoot: string,
  manifest: PluginManifest,
  refreshable: boolean,
): Promise<{ readonly module?: ExternalPluginModule; readonly sourceRevision?: string }> => {
  if (manifest.entry === undefined) {
    return refreshable
      ? {
          sourceRevision: createHash("sha256")
            .update(packageRoot)
            .update(JSON.stringify(manifest))
            .digest("hex"),
        }
      : {};
  }
  const entryPath = await resolvePluginModulePath(packageRoot, String(manifest.name), manifest.entry);
  try {
    let loaded = nativeEntryModules.get(entryPath);
    if (loaded === undefined) {
      loaded = (async () => {
        const sourceRevision = createHash("sha256")
          .update(entryPath)
          .update(await readFile(entryPath))
          .digest("hex");
        const module = (await importAuthorModule(pathToFileURL(entryPath).href)) as ExternalPluginModule;
        return { module, sourceRevision };
      })();
      nativeEntryModules.set(entryPath, loaded);
      const acquired = loaded;
      void acquired.catch(() => {
        if (nativeEntryModules.get(entryPath) === acquired) nativeEntryModules.delete(entryPath);
      });
    }
    const { module, sourceRevision } = await loaded;
    return refreshable ? { module, sourceRevision } : { module };
  } catch (cause) {
    throw pluginLoadError(
      String(manifest.name),
      `Failed to import plugin entry ${manifest.entry}`,
      cause,
      `Repair the ${String(manifest.entry)} entry for plugin ${String(manifest.name)}, or reinstall the plugin.`,
    );
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
  const certificateAuthorities = manifest.contributes?.certificateAuthorities;
  const routerServices = manifest.contributes?.routerServices;
  const secretStores = manifest.contributes?.secretStores;
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
    certificateAuthorities === undefined &&
    routerServices === undefined &&
    secretStores === undefined &&
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
          `Set the ${kind} module to a file inside the plugin package root.`,
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
          "Assign each rendererPanels contribution a unique id within the plugin.",
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
          "Assign each subscriber a unique id within the plugin.",
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
  const normalizedCertificateAuthorities =
    certificateAuthorities === undefined
      ? undefined
      : await Promise.all(
          certificateAuthorities.map(async (contribution) => ({
            ...contribution,
            module: await normalizeManifestModulePath(contribution.module, "certificateAuthorities"),
          })),
        );
  const normalizedRouterServices =
    routerServices === undefined
      ? undefined
      : await Promise.all(
          routerServices.map(async (contribution) => ({
            ...contribution,
            module: await normalizeContributionModulePath(contribution.module),
          })),
        );
  const normalizedSecretStores =
    secretStores === undefined
      ? undefined
      : await Promise.all(
          secretStores.map(async (contribution) => ({
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
      ...(normalizedCertificateAuthorities === undefined
        ? {}
        : { certificateAuthorities: normalizedCertificateAuthorities }),
      ...(normalizedRouterServices === undefined ? {} : { routerServices: normalizedRouterServices }),
      ...(normalizedSecretStores === undefined ? {} : { secretStores: normalizedSecretStores }),
      ...(normalizedRemoteSources === undefined ? {} : { remoteSources: normalizedRemoteSources }),
      ...(normalizedDatasets === undefined ? {} : { datasets: normalizedDatasets }),
      ...(normalizedTunnelServices === undefined ? {} : { tunnelServices: normalizedTunnelServices }),
      ...(normalizedRendererPanels === undefined ? {} : { rendererPanels: normalizedRendererPanels }),
    },
  };
};

export const loadInstalledPluginManifest = async (packageRootInput: string): Promise<PluginManifest> => {
  const packageRoot = packageRootPath(packageRootInput);
  const packageJsonPath = join(packageRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (cause) {
    throw pluginManifestError(
      `Plugin package.json is invalid: ${packageJsonPath}`,
      cause,
      `Make ${packageJsonPath} readable and fix its JSON syntax.`,
    );
  }
  const candidate = (parsed as { landoPlugin?: unknown }).landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownResult(PluginManifest)(candidate, { onExcessProperty: "error" });
  if (Result.isFailure(decoded)) {
    throw pluginManifestError(
      `Plugin manifest validation failed: ${packageJsonPath}`,
      decoded.failure,
      `Correct the reported manifest fields in ${packageJsonPath}.`,
    );
  }
  return normalizeExternalContributionModules(packageRoot, decoded.success);
};

export const loadInstalledPlugin = async (
  packageRootInput: string,
  options: { readonly refreshable?: boolean } = {},
): Promise<{
  readonly manifest: PluginManifest;
  readonly module?: ExternalPluginModule;
  readonly sourceRevision?: string;
}> => {
  const packageRoot = packageRootPath(packageRootInput);
  const manifest = await loadInstalledPluginManifest(packageRoot);
  const loaded = await loadExternalPluginEntry(packageRoot, manifest, options.refreshable === true);
  return { manifest, ...loaded };
};
