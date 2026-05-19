/**
 * `lando app cache:refresh` — rebuild the app plan and command index cache.
 *
 * Per spec §8.2, this command performs full app bootstrap and rebuilds the
 * app plan cache and command index without contacting the provider.
 * Bootstrap level: `app`.
 */
import { Effect } from "effect";

import type {
  CapabilityError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  AppPlanner,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { compileAppCommands } from "../../cache/command-compiler.ts";
import { writeAppCommandCache, writePluginCommandCache } from "../../cache/command-index-writer.ts";
import { type DiscoveredBunShellScript, discoverBunShellScripts } from "../../landofile/bun-sh-discovery.ts";
import { findAppRoot } from "../../landofile/discovery.ts";

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

type AppCacheRefreshError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type AppCacheRefreshServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

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
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const landofile = yield* landofileService.discover;
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);

    const cwd = options.cwd ?? process.cwd();
    const scripts = yield* discoverScripts(cwd);
    const entries = compileAppCommands(landofile, scripts);

    const appCachePath = yield* writeAppCommandCache({
      landofile,
      entries,
      cwd,
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    const pluginCachePath = yield* writePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });

    return {
      app: plan.name,
      commandsCompiled: entries.length,
      ...(appCachePath === undefined ? {} : { appCommandCachePath: appCachePath }),
      ...(pluginCachePath === undefined ? {} : { pluginCommandCachePath: pluginCachePath }),
    };
  });
