/**
 * `lando app cache:refresh` — rebuild the app plan and command index cache.
 *
 * This command performs full app bootstrap and rebuilds the app plan cache
 * and command index without contacting the provider.
 */
import { Effect, Schema } from "effect";

import type {
  AppIdReservedError,
  CacheError,
  CapabilityError,
  ComposeKeyRejectedError,
  LandoCommandError,
  LandofileFormConflictError,
  LandofileIncludeError,
  LandofileLoadExpressionError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  LandofileVersionConstraintError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
  PublicationUnsupportedError,
  ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import {
  AppPlanner,
  LandofileService,
  PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";

import { type DiscoveredBunShellScript, discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { findAppRoot } from "@lando/landofile/discovery";
import { compileAppCommands } from "../../cache/command-compiler.ts";
import {
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "../../cache/command-index-writer.ts";

export interface AppCacheRefreshOptions {
  readonly cwd?: string;
  readonly cacheRoot?: string;
}

export interface AppCacheRefreshResult {
  readonly app: string;
  readonly commandsCompiled: number;
  readonly appCommandCachePath?: string;
  readonly pluginCommandCachePath?: string;
}

export const AppCacheRefreshResultSchema = Schema.Struct({
  app: Schema.String,
  commandsCompiled: Schema.Number,
  appCommandCachePath: Schema.optional(Schema.String),
  pluginCommandCachePath: Schema.optional(Schema.String),
});

type AppCacheRefreshError =
  | AppIdReservedError
  | ComposeKeyRejectedError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NotImplementedError
  | LandofileLoadExpressionError
  | PluginManifestError
  | CapabilityError
  | PublicationUnsupportedError
  | CacheError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type AppCacheRefreshServices = AppPlanner | LandofileService | PluginRegistry | RuntimeProviderRegistry;

export const renderAppCacheRefreshResult = (result: AppCacheRefreshResult): string =>
  `refreshed: ${result.app} (${result.commandsCompiled} command${result.commandsCompiled === 1 ? "" : "s"})`;

const discoverScripts = (cwd: string): Effect.Effect<ReadonlyArray<DiscoveredBunShellScript>, never> =>
  Effect.gen(function* () {
    const appRoot = yield* Effect.promise(() => findAppRoot(cwd));
    if (appRoot === undefined) return [] as ReadonlyArray<DiscoveredBunShellScript>;
    return yield* discoverBunShellScripts({ appRoot }).pipe(
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DiscoveredBunShellScript>)),
    );
  });

export const refreshAppCache = (
  options: AppCacheRefreshOptions = {},
): Effect.Effect<AppCacheRefreshResult, AppCacheRefreshError, AppCacheRefreshServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const pluginRegistry = yield* PluginRegistry;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);

    const cwd = options.cwd ?? process.cwd();
    const scripts = yield* discoverScripts(cwd);
    const entries = compileAppCommands(landofile, scripts);

    const appCachePath = yield* writeAppCommandCacheStrict({
      landofile,
      entries,
      cwd,
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    const pluginCachePath = yield* writePluginCommandCacheStrict({
      manifests: yield* pluginRegistry.list,
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });

    return {
      app: plan.name,
      commandsCompiled: entries.length,
      ...(appCachePath === undefined ? {} : { appCommandCachePath: appCachePath }),
      pluginCommandCachePath: pluginCachePath,
    };
  });
