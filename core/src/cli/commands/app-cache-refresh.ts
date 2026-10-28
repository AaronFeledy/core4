/** Rebuilds the app plan and command index caches without contacting the provider. */
import { Effect, Schema } from "effect";

import type { AppPlanResolutionError } from "@lando/sdk/app";
import type {
  CacheError,
  CommandAliasConflictError,
  CommandAliasTargetError,
  LandoCommandError,
  PluginManifestError,
  SubscriberLevelMismatchError,
} from "@lando/sdk/errors";
import { ToolingCompileError } from "@lando/sdk/errors";
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
import { makeSubscriberRegistrationClosure } from "@lando/engine/lifecycle/subscriber-index";
import { effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
import {
  type BunShellScriptDiscoveryError,
  discoverBunShellScripts,
} from "@lando/landofile/bun-sh-discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { BUILT_IN_COMMAND_IDS } from "../generated/command-ids";

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
  appCommandCachePath: Schema.optionalKey(Schema.String),
  pluginCommandCachePath: Schema.optionalKey(Schema.String),
});

type AppCacheRefreshError =
  | AppPlanResolutionError
  | ProviderError
  | ToolingCompileError
  | PluginManifestError
  | SubscriberLevelMismatchError
  | BunShellScriptDiscoveryError
  | CommandAliasConflictError
  | CommandAliasTargetError
  | CacheError
  | LandoCommandError;

type AppCacheRefreshServices = AppPlanner | LandofileService | PluginRegistry | RuntimeProviderRegistry;

export const renderAppCacheRefreshResult = (result: AppCacheRefreshResult): string =>
  `refreshed: ${result.app} (${result.commandsCompiled} command${result.commandsCompiled === 1 ? "" : "s"})`;

export const refreshAppCache = Effect.fn("AppCacheRefresh.refresh")(function* (
  options: AppCacheRefreshOptions = {},
): Effect.fn.Return<AppCacheRefreshResult, AppCacheRefreshError, AppCacheRefreshServices> {
  const landofileService = yield* LandofileService;
  const pluginRegistry = yield* PluginRegistry;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;

  const landofile = yield* loadUserLandofile(landofileService);
  const capabilities = yield* registry.capabilities;
  const plan = yield* planner.plan(landofile, capabilities);

  const cwd = options.cwd ?? (yield* discoveryCwd());
  const scripts = yield* discoverBunShellScripts({ appRoot: plan.root });
  const entries = yield* Effect.try({
    try: () => compileAppCommands(landofile.document, scripts, effectiveToolingForPlan(plan)),
    catch: (cause) => {
      if (cause instanceof ToolingCompileError) return cause;
      throw cause;
    },
  });
  const aliasError = commandAliasRegistrationError(
    landofile.document.commandAliases,
    entries.map((entry) => entry.id),
    entries,
  );
  if (aliasError !== undefined) yield* Effect.fail(aliasError);

  const manifests = yield* pluginRegistry.list;
  yield* makeSubscriberRegistrationClosure(manifests).close({
    builtIns: BUILT_IN_COMMAND_IDS,
    appCommandIds: entries.map((entry) => entry.id),
  });

  const appCachePath = yield* writeAppCommandCacheStrict({
    landofile: landofile.document,
    entries,
    cwd,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  });
  const pluginCachePath = yield* writePluginCommandCacheStrict({
    manifests,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  });

  return {
    app: plan.name,
    commandsCompiled: entries.length,
    ...(appCachePath === undefined ? {} : { appCommandCachePath: appCachePath }),
    pluginCommandCachePath: pluginCachePath,
  };
});
