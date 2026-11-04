import { dirname } from "node:path";
import {
  type AppCommandCacheReadResult,
  type ReadAppCommandCacheOptions,
  readAppCommandCacheForCwdDetailed,
} from "@lando/engine/cache/command-index-writer";
import { withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import { type DiscoveryOperation, currentDiscoveryOperation } from "@lando/landofile/operation-scope";
import { Effect } from "effect";
import { makeLandoRuntime } from "../runtime/layer";
import { refreshAppCache } from "./commands/app-cache-refresh";

const attempted = new WeakMap<DiscoveryOperation, Set<string>>();

export const rebuildMissingToolingCache = Effect.fnUntraced(function* (
  receipt: Extract<AppCommandCacheReadResult, { readonly status: "missing" }> & {
    readonly sourcePath: string;
  },
  options: ReadAppCommandCacheOptions,
) {
  const operation = currentDiscoveryOperation();
  if (operation !== undefined) {
    const sources = attempted.get(operation) ?? new Set<string>();
    if (sources.has(receipt.sourcePath)) return receipt;
    sources.add(receipt.sourcePath);
    attempted.set(operation, sources);
  }
  const cwd = dirname(receipt.sourcePath);
  yield* Effect.promise(() => import("../runtime/bundled-plugins"));
  return yield* withDiscoveryCwd(cwd, refreshAppCache({ ...options, cwd })).pipe(
    Effect.provide(
      makeLandoRuntime({
        bootstrap: "app",
        cwd,
        plugins: { policy: "discovery" },
        renderer: "json",
        logLevel: "none",
        telemetry: false,
        interaction: "non-interactive",
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      }),
    ),
    Effect.flatMap(() => readAppCommandCacheForCwdDetailed(options)),
    // Best-effort recovery must not replace the original routing/help remediation.
    Effect.catch(() => Effect.succeed(receipt)),
  );
});
