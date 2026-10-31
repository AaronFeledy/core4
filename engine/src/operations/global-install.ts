import { Effect, Schema } from "effect";

import type {
  AppPlacementError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import type { GlobalAppPaths, GlobalDistResult, ProviderSelectionError } from "@lando/sdk/services";
import { GlobalAppService, PluginRegistry, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  seedGlobalEnablement,
  selectGlobalContributions,
  withGlobalMutation,
} from "../global-app/enablement.ts";
import { resolveGlobalServiceContributions } from "../services/global-services.ts";

import { globalCreateProviderId } from "../global-app/placement.ts";
import { bundledFirstGlobalServiceLoader } from "../services/bundled-global-service-loader.ts";
import { materializeGlobalServices } from "../services/global-services.ts";

export interface GlobalInstallOptions {
  readonly plugin?: string;
}

export interface GlobalInstallResult {
  readonly paths: GlobalAppPaths;
  readonly dist: GlobalDistResult;
  readonly userLandofileCreated: boolean;
}

const GlobalAppPathsResultSchema = Schema.Struct({
  root: AbsolutePath,
  distLandofile: AbsolutePath,
  userLandofile: AbsolutePath,
});

const GlobalDistResultSchema = Schema.Struct({
  path: AbsolutePath,
  status: Schema.Literals(["created", "updated", "unchanged"]),
  serviceIds: Schema.Array(Schema.String),
});

export const GlobalInstallResultSchema = Schema.Struct({
  paths: GlobalAppPathsResultSchema,
  dist: GlobalDistResultSchema,
  userLandofileCreated: Schema.Boolean,
});

export const globalInstall = Effect.fn("AppOperation.globalInstall")(
  function* (
    options: GlobalInstallOptions = {},
  ): Effect.fn.Return<
    GlobalInstallResult,
    | GlobalAppError
    | AppPlacementError
    | GlobalDistConflictError
    | GlobalLandofilePathConflictError
    | GlobalServiceCollisionError
    | PluginManifestError
    | ProviderSelectionError,
    GlobalAppService | PluginRegistry | RuntimeProviderRegistry | import("@lando/sdk/services").StateStore
  > {
    const globalApp = yield* GlobalAppService;
    const pluginRegistry = yield* PluginRegistry;
    const registry = yield* RuntimeProviderRegistry;
    const manifests = yield* pluginRegistry.list;
    const contributions = yield* resolveGlobalServiceContributions(manifests);
    const selected = yield* selectGlobalContributions(contributions, options.plugin);
    const enablement = yield* seedGlobalEnablement(
      contributions,
      options.plugin ? { ids: selected.map((entry) => entry.contribution.id), enabled: true } : undefined,
    );
    const provider = yield* registry.select(yield* globalCreateProviderId());
    const services = yield* materializeGlobalServices({
      manifests,
      enablement,
      providerCapabilities: provider.capabilities,
      providerId: provider.id,
      loadServiceConfig: bundledFirstGlobalServiceLoader.load,
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
  },
  (effect, _options: GlobalInstallOptions = {}) => withGlobalMutation(effect),
);
