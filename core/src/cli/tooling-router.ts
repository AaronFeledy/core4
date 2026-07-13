import { Effect } from "effect";

import { ToolingCompileError } from "@lando/sdk/errors";
import type { CacheError } from "@lando/sdk/errors";

import { readFreshAppCommandCacheForCwd } from "../cache/command-index-writer.ts";
import { findAppRoot } from "../landofile/discovery.ts";

const CACHE_REMEDIATION =
  "Run `lando app cache refresh`, `lando start`, or `lando rebuild` to refresh tooling commands.";

export type ToolingRoute =
  | { readonly _tag: "not-tooling" }
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
    };

export interface ResolveToolingRouteOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly cacheRoot?: string;
}

export const toolingName = (token: string): string | undefined => {
  if (token.startsWith("app:")) return token.slice("app:".length) || undefined;
  return token.includes(":") ? undefined : token;
};

export const resolveToolingRoute = (
  options: ResolveToolingRouteOptions,
): Effect.Effect<ToolingRoute, CacheError> =>
  Effect.gen(function* () {
    const token = options.argv[0];
    if (token === undefined) return { _tag: "not-tooling" } as const;
    const name = toolingName(token);
    if (name === undefined) return { _tag: "not-tooling" } as const;

    const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
    if (appRoot === undefined) return { _tag: "not-tooling" } as const;

    const cache = yield* readFreshAppCommandCacheForCwd({
      cwd: appRoot,
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    const commandId = `app:${name}`;
    if (cache === null) {
      return {
        _tag: "cache-miss",
        commandId,
        name,
        argv: options.argv.slice(1),
        remediation: CACHE_REMEDIATION,
      } as const;
    }
    if (!cache.entries.some((entry) => entry.id === commandId)) {
      return {
        _tag: "unknown-tooling",
        commandId,
        name,
        argv: options.argv.slice(1),
        remediation: CACHE_REMEDIATION,
      } as const;
    }

    return { _tag: "tooling", commandId, name, argv: options.argv.slice(1) } as const;
  });

export const toolingRouteError = (
  route: Extract<ToolingRoute, { readonly _tag: "cache-miss" | "unknown-tooling" }>,
): ToolingCompileError =>
  new ToolingCompileError({
    message: `Tooling command ${route.commandId} is unavailable because the app command cache is missing, stale, or does not contain that task.`,
    tool: route.name,
    remediation: route.remediation,
  });
