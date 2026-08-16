/** Rebuilds the app plan and command index caches without contacting the provider. */
import { Effect, Schema } from "effect";

import type {
  AppIdReservedError,
  CacheError,
  CapabilityError,
  CommandAliasConflictError,
  CommandAliasTargetError,
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

import { loadUserLandofile } from "../app-resolution";
import { commandAliasRegistrationError } from "../command-alias-policy";

import { compileAppCommands } from "@lando/engine/cache/command-compiler";
import {
  writeAppCommandCacheStrict,
  writePluginCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
import { effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
import { type DiscoveredBunShellScript, discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { findAppRoot } from "@lando/landofile/discovery";

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
  | CommandAliasConflictError
  | CommandAliasTargetError
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
    const entries = compileAppCommands(landofile, scripts, effectiveToolingForPlan(plan));
    const aliasError = commandAliasRegistrationError(
      landofile.commandAliases,
      entries.map((entry) => entry.id),
    );
    if (aliasError !== undefined) yield* Effect.fail(aliasError);

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
