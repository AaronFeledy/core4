import { Effect } from "effect";

import {
  GlobalAppError,
  type GlobalDistConflictError,
  type GlobalLandofilePathConflictError,
  type GlobalServiceCollisionError,
  type NoProviderInstalledError,
  type PluginManifestError,
  type ProviderConfigError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { GlobalAppPaths, GlobalDistResult } from "@lando/sdk/services";
import { GlobalAppService, PluginRegistry, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  defaultGlobalServiceModuleLoader,
  materializeGlobalServices,
} from "../../../services/global-services.ts";

export interface GlobalInstallOptions {
  readonly plugin?: string;
}

export interface GlobalInstallResult {
  readonly paths: GlobalAppPaths;
  readonly dist: GlobalDistResult;
  readonly userLandofileCreated: boolean;
}

const pluginInstallError = (plugin: string): GlobalAppError =>
  new GlobalAppError({
    message: `Global service plugin installation for ${plugin} is not available yet.`,
    operation: "install",
    remediation:
      "Plugin global-service enablement is a later deliverable; run `lando global:install` with no argument to materialize the global app.",
  });

export const globalInstall = (
  options: GlobalInstallOptions = {},
): Effect.Effect<
  GlobalInstallResult,
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | NoProviderInstalledError
  | PluginManifestError
  | ProviderConfigError
  | ProviderUnavailableError,
  GlobalAppService | PluginRegistry | RuntimeProviderRegistry
> =>
  Effect.gen(function* () {
    if (options.plugin !== undefined && options.plugin !== "") {
      return yield* Effect.fail(pluginInstallError(options.plugin));
    }

    const globalApp = yield* GlobalAppService;
    const pluginRegistry = yield* PluginRegistry;
    const registry = yield* RuntimeProviderRegistry;
    const manifests = yield* pluginRegistry.list;
    const provider = yield* registry.select(undefined);
    const services = yield* materializeGlobalServices({
      manifests,
      providerCapabilities: provider.capabilities,
      providerId: provider.id,
      loadServiceConfig: defaultGlobalServiceModuleLoader.load,
    });

    yield* Effect.scoped(globalApp.ensureRoot);
    const user = yield* globalApp.ensureUserLandofile;
    const dist = yield* globalApp.regenerateDist({ services });
    const paths = yield* globalApp.paths;

    return {
      paths,
      dist,
      userLandofileCreated: user.created,
    };
  });

export const renderGlobalInstallResult = (result: GlobalInstallResult): string =>
  [
    "Global app Landofile stack materialized.",
    `Generated dist Landofile: ${result.dist.path} (${result.dist.status})`,
    `User Landofile: ${result.paths.userLandofile} (${result.userLandofileCreated ? "created" : "preserved"})`,
    `Global services: ${result.dist.serviceIds.length === 0 ? "none" : result.dist.serviceIds.join(", ")}`,
  ].join("\n");
