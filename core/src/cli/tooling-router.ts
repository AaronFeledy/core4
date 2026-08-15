import { Effect } from "effect";

import {
  type CommandAliasConflictError,
  type CommandAliasTargetError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import type { CacheError } from "@lando/sdk/errors";

import { readFreshAppCommandCacheForCwd } from "@lando/engine/cache/command-index-writer";
import { findAppRoot } from "@lando/landofile/discovery";
import { type BuiltInCommandEntry, resolveBuiltInCommand } from "./built-in-command-registry";
import { activeCommandAliases, canonicalBuiltIn, commandAliasPolicyError } from "./command-alias-policy";
import { escapeDiagnosticText } from "./diagnostic-text";

const CACHE_REMEDIATION =
  "Run `lando app:cache:refresh`, `lando start`, or `lando rebuild` to refresh tooling commands.";

export type ToolingRoute =
  | { readonly _tag: "not-tooling" }
  | {
      readonly _tag: "built-in";
      readonly commandId: string;
      readonly entry: BuiltInCommandEntry;
      readonly argv: ReadonlyArray<string>;
    }
  | { readonly _tag: "alias-disabled"; readonly token: string }
  | {
      readonly _tag: "cache-miss";
      readonly commandId: string;
      readonly name: string;
      readonly argv: ReadonlyArray<string>;
      readonly remediation: string;
    }
  | {
      readonly _tag: "unknown-tooling";
      readonly commandId: string;
      readonly name: string;
      readonly argv: ReadonlyArray<string>;
      readonly remediation: string;
    }
  | {
      readonly _tag: "tooling";
      readonly commandId: string;
      readonly name: string;
      readonly argv: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "bun-script";
      readonly commandId: string;
      readonly name: string;
      readonly argv: ReadonlyArray<string>;
      readonly appRoot: string;
    };

export interface ResolveToolingRouteOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly cacheRoot?: string;
}

export const resolveAppCommandHelpAliases = (
  options: { readonly cwd?: string; readonly cacheRoot?: string } = {},
): Effect.Effect<
  ReadonlyArray<readonly [string, string]> | undefined,
  CacheError | CommandAliasConflictError | CommandAliasTargetError
> =>
  Effect.gen(function* () {
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

export const resolveToolingRoute = (
  options: ResolveToolingRouteOptions,
): Effect.Effect<ToolingRoute, CacheError | CommandAliasConflictError | CommandAliasTargetError> =>
  Effect.gen(function* () {
    const token = options.argv[0];
    if (token === undefined) return { _tag: "not-tooling" } as const;
    if (canonicalBuiltIn(token) !== undefined) return { _tag: "not-tooling" } as const;
    const name = toolingName(token);

    const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
    if (appRoot === undefined) return { _tag: "not-tooling" } as const;

    const cache = yield* readFreshAppCommandCacheForCwd({
      cwd: appRoot,
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    const commandArgv = options.argv.slice(1);
    if (cache === null) {
      const registeredAlias = resolveBuiltInCommand(token);
      if (registeredAlias !== undefined) {
        return {
          _tag: "built-in",
          commandId: registeredAlias.spec.id,
          entry: registeredAlias,
          argv: commandArgv,
        } as const;
      }
      if (name === undefined) return { _tag: "not-tooling" } as const;
      const commandId = `app:${name}`;
      return {
        _tag: "cache-miss",
        commandId,
        name,
        argv: commandArgv,
        remediation: CACHE_REMEDIATION,
      } as const;
    }

    const canonicalEntry = cache.entries.find((candidate) => candidate.id === token);
    if (canonicalEntry !== undefined) {
      const canonicalName = token.startsWith("app:") ? token.slice("app:".length) : token;
      if (canonicalEntry.source === "bun-script") {
        return {
          _tag: "bun-script",
          commandId: token,
          name: canonicalName,
          argv: commandArgv,
          appRoot,
        } as const;
      }
      return { _tag: "tooling", commandId: token, name: canonicalName, argv: commandArgv } as const;
    }

    const policy = cache.aliasPolicy;
    const policyError = commandAliasPolicyError(cache);
    if (policyError !== undefined) return yield* Effect.fail(policyError);
    if (policy?.enabled === false) return { _tag: "alias-disabled", token } as const;

    const customTarget = policy?.custom[token];
    if (customTarget !== undefined) {
      const builtInTarget = canonicalBuiltIn(customTarget);
      if (builtInTarget !== undefined) {
        return {
          _tag: "built-in",
          commandId: customTarget,
          entry: builtInTarget,
          argv: commandArgv,
        } as const;
      }
      const customEntry = cache.entries.find((candidate) => candidate.id === customTarget);
      const customName = customTarget.startsWith("app:") ? customTarget.slice("app:".length) : customTarget;
      if (customEntry === undefined)
        return {
          _tag: "unknown-tooling",
          commandId: customTarget,
          name: customName,
          argv: commandArgv,
          remediation: CACHE_REMEDIATION,
        } as const;
      if (customEntry.source === "bun-script") {
        return {
          _tag: "bun-script",
          commandId: customTarget,
          name: customName,
          argv: commandArgv,
          appRoot,
        } as const;
      }
      return {
        _tag: "tooling",
        commandId: customTarget,
        name: customName,
        argv: commandArgv,
      } as const;
    }

    if (policy?.disabled.includes(token) === true) return { _tag: "alias-disabled", token } as const;

    const registeredAlias = resolveBuiltInCommand(token);
    if (registeredAlias !== undefined) {
      return {
        _tag: "built-in",
        commandId: registeredAlias.spec.id,
        entry: registeredAlias,
        argv: commandArgv,
      } as const;
    }

    if (name === undefined) return { _tag: "not-tooling" } as const;
    const commandId = `app:${name}`;
    const entry = cache.entries.find((candidate) => candidate.id === commandId);
    if (entry === undefined) {
      return {
        _tag: "unknown-tooling",
        commandId,
        name,
        argv: commandArgv,
        remediation: CACHE_REMEDIATION,
      } as const;
    }

    if (entry.source === "bun-script") {
      return {
        _tag: "bun-script",
        commandId,
        name,
        argv: commandArgv,
        appRoot,
      } as const;
    }
    return { _tag: "tooling", commandId, name, argv: commandArgv } as const;
  });

export const toolingRouteError = (
  route: Extract<ToolingRoute, { readonly _tag: "cache-miss" | "unknown-tooling" }>,
): ToolingCompileError =>
  new ToolingCompileError({
    message: `Tooling command ${escapeDiagnosticText(route.commandId)} is unavailable because the app command cache is missing, stale, or does not contain that task.`,
    tool: route.name,
    remediation: route.remediation,
  });
