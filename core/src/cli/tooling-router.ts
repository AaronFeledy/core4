import { Effect } from "effect";

import { ToolingCompileError } from "@lando/sdk/errors";
import type { CacheError } from "@lando/sdk/errors";

import { readFreshAppCommandCacheForCwd } from "@lando/engine/cache/command-index-writer";
import { findAppRoot } from "@lando/landofile/discovery";
import { escapeDiagnosticText } from "./diagnostic-text";

const CACHE_REMEDIATION =
  "Run `lando app:cache:refresh`, `lando start`, or `lando rebuild` to refresh tooling commands.";

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

export const toolingName = (token: string): string | undefined => {
  if (token.startsWith("-")) return undefined;
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
    const commandArgv = options.argv.slice(1);
    if (cache === null) {
      return {
        _tag: "cache-miss",
        commandId,
        name,
        argv: commandArgv,
        remediation: CACHE_REMEDIATION,
      } as const;
    }
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
