import {
  type ReadAppCommandCacheOptions,
  readAppCommandCacheForCwdDetailed,
} from "@lando/engine/cache/command-index-writer";
import { resolveLandoRoots } from "@lando/paths";
import type { CacheError, LandofileFormConflictError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { CliInvocation } from "../runtime/invocation-context";
import type { CliAppCommandCacheReadResult } from "./tooling-cache-status";

export interface ReadCliAppCommandCacheOptions extends ReadAppCommandCacheOptions {
  /** Rebuild a missing, stale, or invalid index once through the `app:cache:refresh` operation. */
  readonly rebuild?: boolean;
  /** Announce a slow rebuild on stderr; protocol-stdout hosts such as MCP turn it off. */
  readonly rebuildNotice?: boolean;
}

/** Fresh reads stay cache-only; only a non-fresh index of a resolved app loads the rebuild path. */
export const readCliAppCommandCache = Effect.fnUntraced(function* (
  options: ReadCliAppCommandCacheOptions = {},
): Effect.fn.Return<CliAppCommandCacheReadResult, CacheError | LandofileFormConflictError> {
  const invocation = yield* CliInvocation;
  const roots = resolveLandoRoots({ env: invocation.env });
  const scoped = {
    ...options,
    cwd: options.cwd ?? invocation.cwd,
    cacheRoot: options.cacheRoot ?? roots.userCacheRoot,
    roots,
  };
  const receipt = yield* readAppCommandCacheForCwdDetailed(scoped);
  if (receipt.status === "fresh" || receipt.sourcePath === undefined || options.rebuild === false)
    return receipt;
  const { rebuildToolingCache } = yield* Effect.promise(() => import("./tooling-cache-rebuild"));
  return yield* rebuildToolingCache({ ...receipt, sourcePath: receipt.sourcePath }, scoped);
});
