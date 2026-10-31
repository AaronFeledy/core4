import { Effect } from "effect";

import {
  type BunShellScriptEmptyError,
  type BunShellScriptFrontMatterError,
  type CacheError,
  type CommandAliasConflictError,
  type CommandAliasTargetError,
  type LandofileFormConflictError,
  type NotImplementedError,
  ToolingCommandUnavailableError,
} from "@lando/sdk/errors";

import { compileBunShellScriptCommand } from "@lando/engine/cache/command-compiler";
import {
  readAppCommandCacheForCwdDetailed,
  readFreshAppCommandCacheForCwd,
} from "@lando/engine/cache/command-index-writer";
import { resolveBunShellScript } from "@lando/landofile/bun-sh-script";
import { findAppRoot } from "@lando/landofile/discovery";
import {
  type BuiltInCommandEntry,
  builtInCommandEntries,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { activeCommandAliases, commandAliasPolicyError } from "./command-alias-policy";
import { buildCommandCatalog } from "./command-catalog";
import { escapeDiagnosticText } from "./diagnostic-text";
import { createPluginCommandCatalog } from "./plugin-command-catalog";
import { toolingCacheRecovery } from "./tooling-cache-status";
import { type ToolingRoute, bunScriptRoute, normalizedToolingRoute } from "./tooling-route";

export { type ToolingRoute, type NormalizedToolingRoute, toolingHelpRequested } from "./tooling-route";

const UNKNOWN_REMEDIATION = "Check the task name with `lando help` or inspect the app's tooling definitions.";

const canonicalBuiltIn = (commandId: string): BuiltInCommandEntry | undefined =>
  builtInCommandEntries.find((entry) => entry.spec.id === commandId);

export interface ResolveToolingRouteOptions {
  readonly cwd?: string;
  readonly cacheRoot?: string;
}

export const resolveAppCommandHelpAliases = Effect.fnUntraced(function* (
  options: { readonly cwd?: string; readonly cacheRoot?: string } = {},
): Effect.fn.Return<
  ReadonlyArray<readonly [string, string]> | undefined,
  CacheError | CommandAliasConflictError | CommandAliasTargetError
> {
  const appRoot = yield* findAppRoot(options.cwd);
  if (appRoot === undefined) return undefined;
  const cache = yield* readFreshAppCommandCacheForCwd({
    cwd: appRoot,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  }).pipe(Effect.catchTag("LandofileFormConflictError", () => Effect.succeed(null)));
  if (cache === null) return undefined;
  const plugins = (yield* Effect.promise(() => createPluginCommandCatalog().list())).rows;
  const pluginIds = plugins.map((entry) => entry.id);
  const policyError = commandAliasPolicyError(cache, pluginIds);
  if (policyError !== undefined) return yield* Effect.fail(policyError);
  return activeCommandAliases(cache, plugins);
});

export const toolingName = (token: string): string | undefined => {
  if (token.startsWith("-")) return undefined;
  if (token.startsWith("app:")) return token.slice("app:".length) || undefined;
  return token.includes(":") ? undefined : token;
};

export const resolveToolingRoute = Effect.fnUntraced(function* (
  token: string | undefined,
  options: ResolveToolingRouteOptions = {},
): Effect.fn.Return<
  ToolingRoute,
  | CacheError
  | LandofileFormConflictError
  | CommandAliasConflictError
  | CommandAliasTargetError
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | NotImplementedError
> {
  if (token === undefined) return { _tag: "not-tooling" } as const;
  if (canonicalBuiltIn(token) !== undefined) return { _tag: "not-tooling" } as const;
  // Flags are never tooling tokens; bail before app-root/cache so enabled:false
  // and disabled lists cannot capture --help/-h/--version/-V/-v.
  if (token.startsWith("-")) return { _tag: "not-tooling" } as const;
  const name = toolingName(token);

  const appRoot = yield* findAppRoot(options.cwd);
  if (appRoot === undefined) return { _tag: "not-tooling" } as const;

  const receipt = yield* readAppCommandCacheForCwdDetailed({
    cwd: appRoot,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  }).pipe(
    // A built-in owns its Landofile policy (teardown tolerates the conflict, start reports it),
    // so only a tooling token fails here.
    Effect.catchTag("LandofileFormConflictError", (error) =>
      resolveBuiltInCommand(token) === undefined ? Effect.fail(error) : Effect.succeed(null),
    ),
  );
  if (receipt === null || receipt.status !== "fresh") {
    const registeredAlias = resolveBuiltInCommand(token);
    if (registeredAlias !== undefined) {
      return {
        _tag: "built-in",
        commandId: registeredAlias.spec.id,
        entry: registeredAlias,
      } as const;
    }
    if (name === undefined) return { _tag: "not-tooling" } as const;
    const commandId = `app:${name}`;
    return {
      _tag: "cache-miss",
      commandId,
      name,
      ...toolingCacheRecovery(receipt ?? { status: "missing" }),
    } as const;
  }
  const cache = receipt.payload;

  const canonicalEntry = cache.entries.find((candidate) => candidate.id === token);
  if (canonicalEntry !== undefined) {
    if (canonicalEntry.source === "bun-script") {
      return bunScriptRoute(canonicalEntry, appRoot, cache);
    }
    return normalizedToolingRoute(canonicalEntry, cache.aliasPolicy, cache.sourceFile);
  }

  const policy = cache.aliasPolicy;
  const aliasesEnabled = policy?.enabled !== false;
  const plugins = (yield* Effect.promise(() => createPluginCommandCatalog().list())).rows;
  const catalog = buildCommandCatalog(plugins, cache);
  const pluginIds = plugins.map((entry) => entry.id);
  const policyError = commandAliasPolicyError(cache, pluginIds);
  if (policyError !== undefined) return yield* Effect.fail(policyError);

  const custom =
    policy?.custom !== undefined && Object.hasOwn(policy.custom, token) ? policy.custom[token] : undefined;
  if (aliasesEnabled && custom !== undefined) {
    if (pluginIds.includes(custom)) return { _tag: "plugin", commandId: custom, token } as const;
    const builtInTarget = canonicalBuiltIn(custom);
    if (builtInTarget !== undefined) {
      return {
        _tag: "built-in",
        commandId: custom,
        entry: builtInTarget,
      } as const;
    }
    const customEntry = cache.entries.find((candidate) => candidate.id === custom);
    const customName = custom.startsWith("app:") ? custom.slice("app:".length) : custom;
    if (customEntry === undefined)
      return {
        _tag: "unknown-tooling",
        commandId: custom,
        name: customName,
        remediation: UNKNOWN_REMEDIATION,
      } as const;
    if (customEntry.source === "bun-script") {
      return bunScriptRoute(customEntry, appRoot, cache);
    }
    return normalizedToolingRoute(customEntry, cache.aliasPolicy, cache.sourceFile);
  }

  if (aliasesEnabled && policy?.disabled.includes(token)) return { _tag: "alias-disabled", token } as const;

  const catalogEntry = catalog.resolve(token);
  if (catalogEntry?.source === "plugin" && catalogEntry.id !== token)
    return { _tag: "plugin", commandId: catalogEntry.id, token } as const;
  const registeredAlias = catalogEntry?.source === "built-in" ? canonicalBuiltIn(catalogEntry.id) : undefined;
  const isKnownAlias = custom !== undefined || resolveBuiltInCommand(token) !== undefined;
  if (aliasesEnabled && registeredAlias !== undefined) {
    return {
      _tag: "built-in",
      commandId: registeredAlias.spec.id,
      entry: registeredAlias,
    } as const;
  }

  if (name === undefined) {
    if (!aliasesEnabled && isKnownAlias) return { _tag: "alias-disabled", token } as const;
    return { _tag: "not-tooling" } as const;
  }
  const commandId = `app:${name}`;
  const entry = cache.entries.find((candidate) => candidate.id === commandId);
  if (entry === undefined) {
    if (!aliasesEnabled && isKnownAlias) return { _tag: "alias-disabled", token } as const;
    const script = yield* resolveBunShellScript(appRoot, name);
    if (script !== undefined) {
      const entry = yield* Effect.fromResult(compileBunShellScriptCommand(script));
      return { ...bunScriptRoute(entry, appRoot, cache), relativePath: script.relativePath };
    }
    return {
      _tag: "unknown-tooling",
      commandId,
      name,
      remediation: UNKNOWN_REMEDIATION,
    } as const;
  }

  if (entry.source === "bun-script") {
    return bunScriptRoute(entry, appRoot, cache);
  }
  return normalizedToolingRoute(entry, cache.aliasPolicy, cache.sourceFile);
});

export const toolingRouteError = (
  route: Extract<ToolingRoute, { readonly _tag: "cache-miss" | "unknown-tooling" }>,
): ToolingCommandUnavailableError =>
  new ToolingCommandUnavailableError({
    message: `Tooling command ${escapeDiagnosticText(route.commandId)} is unavailable (${route._tag === "unknown-tooling" ? "unknown-command" : route.reason}).`,
    commandId: route.commandId,
    tool: route.name,
    reason: route._tag === "unknown-tooling" ? "unknown-command" : route.reason,
    ...(route._tag === "cache-miss" && route.staleReason !== undefined
      ? { staleReason: route.staleReason }
      : {}),
    ...(route._tag === "cache-miss" && route.sourcePath !== undefined
      ? { sourcePath: route.sourcePath }
      : {}),
    remediation: route.remediation,
  });
