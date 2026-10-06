import { Effect } from "effect";

import {
  type BunShellScriptEmptyError,
  type BunShellScriptFrontMatterError,
  type CacheError,
  type CommandAliasConflictError,
  type CommandAliasTargetError,
  type NotImplementedError,
  ToolingCompileError,
} from "@lando/sdk/errors";

import type { AppCommandIndexPayload, CommandIndexEntry } from "@lando/engine/cache/command-index";
import { readFreshAppCommandCacheForCwd } from "@lando/engine/cache/command-index-writer";
import { canonicalIdFromRelativePath } from "@lando/landofile/bun-sh-discovery";
import { resolveBunShellScript } from "@lando/landofile/bun-sh-script";
import { findAppRoot } from "@lando/landofile/discovery";
import {
  type BuiltInCommandEntry,
  builtInCommandEntries,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { activeCommandAliases, commandAliasPolicyError } from "./command-alias-policy";
import { escapeDiagnosticText } from "./diagnostic-text";

const CACHE_REMEDIATION =
  "Run `lando app:cache:refresh`, `lando start`, or `lando rebuild` to refresh tooling commands.";

const canonicalBuiltIn = (commandId: string): BuiltInCommandEntry | undefined =>
  builtInCommandEntries.find((entry) => entry.spec.id === commandId);

export type ToolingRoute =
  | { readonly _tag: "not-tooling" }
  | {
      readonly _tag: "built-in";
      readonly commandId: string;
      readonly entry: BuiltInCommandEntry;
    }
  | { readonly _tag: "alias-disabled"; readonly token: string }
  | {
      readonly _tag: "cache-miss";
      readonly commandId: string;
      readonly name: string;
      readonly remediation: string;
    }
  | {
      readonly _tag: "unknown-tooling";
      readonly commandId: string;
      readonly name: string;
      readonly remediation: string;
    }
  | {
      readonly _tag: "tooling";
      readonly commandId: string;
      readonly name: string;
      readonly hidden: boolean;
      readonly input?: CommandIndexEntry["input"];
    }
  | {
      readonly _tag: "bun-script";
      readonly commandId: string;
      readonly name: string;
      readonly appRoot: string;
      readonly relativePath?: string;
    };

export type NormalizedToolingRoute = Extract<ToolingRoute, { readonly _tag: "tooling" }>;

const bunScriptRoute = (
  commandId: string,
  appRoot: string,
  cache: AppCommandIndexPayload,
): Extract<ToolingRoute, { readonly _tag: "bun-script" }> => {
  const relativePath = cache.sourceScripts?.find(
    (script) => canonicalIdFromRelativePath(script.relativePath)?.id === commandId,
  )?.relativePath;
  return {
    _tag: "bun-script",
    commandId,
    name: commandId.slice("app:".length),
    appRoot,
    ...(relativePath === undefined ? {} : { relativePath }),
  };
};

const normalizedToolingRoute = (
  commandId: string,
  name: string,
  entry: CommandIndexEntry,
): NormalizedToolingRoute => ({
  _tag: "tooling",
  commandId,
  name,
  hidden: entry.hidden,
  ...(entry.input === undefined ? {} : { input: entry.input }),
});

/**
 * Declared flags and args make Lando the owner of the task's argv, so `--help` describes the
 * declaration instead of reaching the command. Raw-passthrough tasks keep handing `--help` to the
 * tool they wrap, hidden tasks keep their own refusal, and a declared help flag wins over ours.
 */
export const toolingHelpRequested = (
  route: ToolingRoute,
  argv: ReadonlyArray<string>,
): route is NormalizedToolingRoute => {
  if (route._tag !== "tooling" || route.hidden || route.input === undefined) return false;
  if (route.input.flags.some((flag) => flag.name === "help" || flag.alias === "h")) return false;
  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
  }
  return false;
};

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
  const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
  if (appRoot === undefined) return undefined;
  const cache = yield* readFreshAppCommandCacheForCwd({
    cwd: appRoot,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  });
  if (cache === null) return undefined;
  const policyError = commandAliasPolicyError(cache);
  if (policyError !== undefined) return yield* Effect.fail(policyError);
  return activeCommandAliases(cache);
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

  const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
  if (appRoot === undefined) return { _tag: "not-tooling" } as const;

  const cache = yield* readFreshAppCommandCacheForCwd({
    cwd: appRoot,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  });
  if (cache === null) {
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
      remediation: CACHE_REMEDIATION,
    } as const;
  }

  const canonicalEntry = cache.entries.find((candidate) => candidate.id === token);
  if (canonicalEntry !== undefined) {
    const canonicalName = token.startsWith("app:") ? token.slice("app:".length) : token;
    if (canonicalEntry.source === "bun-script") {
      return bunScriptRoute(token, appRoot, cache);
    }
    return normalizedToolingRoute(token, canonicalName, canonicalEntry);
  }

  const policy = cache.aliasPolicy;
  const aliasesEnabled = policy?.enabled !== false;
  const policyError = commandAliasPolicyError(cache);
  if (policyError !== undefined) return yield* Effect.fail(policyError);

  const custom =
    policy?.custom !== undefined && Object.hasOwn(policy.custom, token) ? policy.custom[token] : undefined;
  if (aliasesEnabled && custom !== undefined) {
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
        remediation: CACHE_REMEDIATION,
      } as const;
    if (customEntry.source === "bun-script") {
      return bunScriptRoute(custom, appRoot, cache);
    }
    return normalizedToolingRoute(custom, customName, customEntry);
  }

  if (aliasesEnabled && policy?.disabled.includes(token)) return { _tag: "alias-disabled", token } as const;

  const registeredAlias = resolveBuiltInCommand(token);
  const isKnownAlias = custom !== undefined || registeredAlias !== undefined;
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
    if (script !== undefined)
      return { _tag: "bun-script", commandId, name, appRoot, relativePath: script.relativePath } as const;
    return {
      _tag: "unknown-tooling",
      commandId,
      name,
      remediation: CACHE_REMEDIATION,
    } as const;
  }

  if (entry.source === "bun-script") {
    return bunScriptRoute(commandId, appRoot, cache);
  }
  return normalizedToolingRoute(commandId, name, entry);
});

export const toolingRouteError = (
  route: Extract<ToolingRoute, { readonly _tag: "cache-miss" | "unknown-tooling" }>,
): ToolingCompileError =>
  new ToolingCompileError({
    message: `Tooling command ${escapeDiagnosticText(route.commandId)} is unavailable because the app command cache is missing, stale, or does not contain that task.`,
    tool: route.name,
    remediation: route.remediation,
  });
