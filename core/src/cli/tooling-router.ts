import { resolveLandoRoots } from "@lando/paths";
import { Effect } from "effect";
import { CliInvocation } from "../runtime/invocation-context";

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
import { readFreshAppCommandCacheForCwd } from "@lando/engine/cache/command-index-writer";
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
import { type PluginCommandCatalog, createPluginCommandCatalog } from "./plugin-command-catalog";
import { toolingCacheRecovery } from "./tooling-cache-status";
import { readCliAppCommandCache } from "./tooling-command-cache";
import { type ToolingRoute, bunScriptRoute, normalizedToolingRoute } from "./tooling-route";

export {
  type ToolingRoute,
  type NormalizedToolingRoute,
  toolingHelpRequested,
  toolingVersionRequested,
} from "./tooling-route";

const canonicalBuiltIn = (commandId: string): BuiltInCommandEntry | undefined =>
  builtInCommandEntries.find((entry) => entry.spec.id === commandId);

/**
 * The live error of a script route, or undefined when the script resolves. Invocation re-resolves
 * every script itself; help checks here so it never prints a page for a script that cannot run,
 * such as one a collision added after the index was built.
 */
export const unavailableScriptError = (route: ToolingRoute) =>
  route._tag === "bun-script"
    ? resolveBunShellScript(route.appRoot, route.commandId).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
      )
    : Effect.succeed(undefined);

export interface ResolveToolingRouteOptions {
  readonly cwd?: string;
  readonly cacheRoot?: string;
  readonly rebuild?: boolean;
  /** Allow the slow-rebuild stderr notice; callers that resolve before output modes are set decide here. */
  readonly rebuildNotice?: boolean;
  /** The invocation's plugin catalog; routing never acquires a second one. */
  readonly catalog?: PluginCommandCatalog;
}

export const resolveAppCommandHelpAliases = Effect.fnUntraced(function* (
  options: ResolveToolingRouteOptions = {},
): Effect.fn.Return<
  ReadonlyArray<readonly [string, string]> | undefined,
  CacheError | CommandAliasConflictError | CommandAliasTargetError
> {
  const appRoot = yield* findAppRoot(options.cwd);
  if (appRoot === undefined) return undefined;
  const roots = resolveLandoRoots({ env: (yield* CliInvocation).env });
  const cache = yield* readFreshAppCommandCacheForCwd({
    cwd: appRoot,
    cacheRoot: options.cacheRoot ?? roots.userCacheRoot,
    roots,
  }).pipe(Effect.catchTag("LandofileFormConflictError", () => Effect.succeed(null)));
  if (cache === null) return undefined;
  const catalog = options.catalog ?? createPluginCommandCatalog();
  const plugins = (yield* Effect.promise(() => catalog.list())).rows;
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

  const receipt = yield* readCliAppCommandCache({
    cwd: appRoot,
    // A non-fresh index already yields to a built-in alias below; rebuilding first would only run
    // app compile side effects (include pinning) ahead of a command that owns its own policy.
    rebuild: options.rebuild !== false && resolveBuiltInCommand(token) === undefined,
    ...(options.rebuildNotice === undefined ? {} : { rebuildNotice: options.rebuildNotice }),
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
    if (receipt?.status === "rebuild-failed") {
      const { sourcePath, error } = receipt;
      return { _tag: "cache-miss", reason: "rebuild-failed", commandId, name, sourcePath, error } as const;
    }
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
  // Plugin aliases yield to built-in aliases, and only custom aliases can make plugin ids change
  // policy validation, so a built-in alias routes without acquiring plugin metadata.
  const builtInOnly = buildCommandCatalog([], cache);
  const pluginsMatter =
    Object.keys(policy?.custom ?? {}).length > 0 || builtInOnly.resolve(token)?.source !== "built-in";
  const plugins = pluginsMatter
    ? (yield* Effect.promise(() => (options.catalog ?? createPluginCommandCatalog()).list())).rows
    : [];
  const catalog = pluginsMatter ? buildCommandCatalog(plugins, cache) : builtInOnly;
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
      return { _tag: "unknown-tooling", commandId: custom, name: customName } as const;
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
    const resolved = yield* Effect.result(resolveBunShellScript(appRoot, name));
    // A script added since the index was built still answers as `app:<name>`, broken or not.
    if (resolved._tag === "Failure")
      return bunScriptRoute(
        {
          id: commandId,
          summary: "Unavailable script",
          hidden: false,
          source: "bun-script",
          loadError: {
            _tag: resolved.failure._tag,
            message: resolved.failure.message,
            remediation: resolved.failure.remediation,
          },
        },
        appRoot,
        cache,
      );
    const script = resolved.success;
    if (script !== undefined) {
      const entry = yield* Effect.fromResult(compileBunShellScriptCommand(script));
      return { ...bunScriptRoute(entry, appRoot, cache), relativePath: script.relativePath };
    }
    return { _tag: "unknown-tooling", commandId, name } as const;
  }

  if (entry.source === "bun-script") {
    return bunScriptRoute(entry, appRoot, cache);
  }
  return normalizedToolingRoute(entry, cache.aliasPolicy, cache.sourceFile);
});

type ToolingCacheMiss = Extract<ToolingRoute, { readonly _tag: "cache-miss" }>;

export const toolingRouteFailure = (route: ToolingCacheMiss, hint?: string): unknown => {
  if (route.reason === "rebuild-failed") return route.error;
  return toolingRouteError(
    hint === undefined ? route : { ...route, remediation: `${route.remediation} ${hint}` },
  );
};

export const toolingRouteError = (
  route: Exclude<ToolingCacheMiss, { readonly reason: "rebuild-failed" }>,
): ToolingCommandUnavailableError =>
  new ToolingCommandUnavailableError({
    message: `Tooling command ${escapeDiagnosticText(route.commandId)} is unavailable (${route.reason}).`,
    commandId: route.commandId,
    tool: route.name,
    reason: route.reason,
    ...(route.staleReason === undefined ? {} : { staleReason: route.staleReason }),
    ...(route.sourcePath === undefined ? {} : { sourcePath: route.sourcePath }),
    remediation: route.remediation,
  });
