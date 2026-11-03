import {
  type ReadAppCommandCacheOptions,
  readAppCommandCacheForCwdDetailed,
} from "@lando/engine/cache/command-index-writer";
import { Effect } from "effect";

/** Only absent app metadata may acquire a runtime; fresh reads stay cache-only. */
export const readCliAppCommandCache = Effect.fnUntraced(function* (
  options: ReadAppCommandCacheOptions & { readonly rebuildMissing?: boolean } = {},
) {
  const receipt = yield* readAppCommandCacheForCwdDetailed(options);
  if (receipt.status !== "missing" || receipt.sourcePath === undefined || options.rebuildMissing === false)
    return receipt;
  const { rebuildMissingToolingCache } = yield* Effect.promise(() => import("./tooling-cache-rebuild"));
  return yield* rebuildMissingToolingCache({ ...receipt, sourcePath: receipt.sourcePath }, options);
});
