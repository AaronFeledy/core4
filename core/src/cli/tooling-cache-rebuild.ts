import { dirname } from "node:path";
import {
  type AppCommandCacheReadResult,
  readAppCommandCacheForCwdDetailed,
} from "@lando/engine/cache/command-index-writer";
import { withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import { type DiscoveryOperation, currentDiscoveryOperation } from "@lando/landofile/operation-scope";
import type { CacheError, LandofileFormConflictError } from "@lando/sdk/errors";
import { Effect, Fiber } from "effect";
import { makeLandoRuntime } from "../runtime/layer";
import { refreshAppCache } from "./commands/app-cache-refresh";
import { activeRendererMode, activeResultFormat, emitDiagnosticLine } from "./compiled-session";
import { isEnvelopeResultFormat } from "./format-flags";
import { readConfigCliGlobals } from "./renderer-mode-resolution";
import type { CliAppCommandCacheReadResult } from "./tooling-cache-status";
import type { ReadCliAppCommandCacheOptions } from "./tooling-command-cache";

type PendingReceipt = Exclude<AppCommandCacheReadResult, { readonly status: "fresh" }> & {
  readonly sourcePath: string;
};
type RebuildFailedReceipt = Extract<CliAppCommandCacheReadResult, { readonly status: "rebuild-failed" }>;

const SLOW_REBUILD_NOTICE_DELAY = "500 millis";

/** One rebuild per app source per discovery operation; a failure is replayed, never retried. */
const attempted = new WeakMap<DiscoveryOperation, Map<string, RebuildFailedReceipt | undefined>>();

const slowRebuildNotice = (receipt: PendingReceipt): string => {
  switch (receipt.status) {
    case "missing":
      return "Reading this app's commands...";
    case "invalid":
      return "Updating this app's commands for this Lando version...";
    case "stale":
      switch (receipt.staleReason) {
        case "lando-version":
        case "format":
          return "Updating this app's commands for this Lando version...";
        case "source":
        case "version-constraint":
          return "Updating this app's commands (Landofile changed)...";
        case "referenced-file":
          return "Updating this app's commands (a file the Landofile loads changed)...";
        case "script-metadata":
        case "script-inventory":
          return "Updating this app's commands (scripts changed)...";
        default:
          return receipt.staleReason satisfies never;
      }
    default:
      return receipt satisfies never;
  }
};

const withSlowRebuildNotice = <A, E, R>(
  receipt: PendingReceipt,
  enabled: boolean,
  rebuild: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  // Progress belongs to an interactive terminal: piped stderr and machine output never gain a line.
  enabled &&
  process.stderr.isTTY === true &&
  activeRendererMode !== "json" &&
  !isEnvelopeResultFormat(activeResultFormat)
    ? Effect.gen(function* () {
        const notice = yield* Effect.forkChild(
          Effect.sleep(SLOW_REBUILD_NOTICE_DELAY).pipe(
            // Routing can start before the configured renderer is applied, so a config-selected
            // json renderer is checked here, only once a rebuild is already slow. An unreadable
            // config skips this cosmetic line; the rebuild and the command report that error.
            Effect.andThen(Effect.tryPromise(readConfigCliGlobals)),
            Effect.flatMap((config) =>
              config.renderer === "json"
                ? Effect.void
                : Effect.promise(() => emitDiagnosticLine(slowRebuildNotice(receipt))),
            ),
            Effect.catchTag("UnknownError", () => Effect.void),
          ),
        );
        return yield* rebuild.pipe(Effect.ensuring(Fiber.interrupt(notice)));
      })
    : rebuild;

export const rebuildToolingCache = Effect.fnUntraced(function* (
  receipt: PendingReceipt,
  options: ReadCliAppCommandCacheOptions,
): Effect.fn.Return<CliAppCommandCacheReadResult, CacheError | LandofileFormConflictError> {
  const operation = currentDiscoveryOperation();
  const sources =
    operation === undefined
      ? undefined
      : (attempted.get(operation) ?? new Map<string, RebuildFailedReceipt | undefined>());
  if (sources?.has(receipt.sourcePath)) return sources.get(receipt.sourcePath) ?? receipt;
  sources?.set(receipt.sourcePath, undefined);
  if (operation !== undefined && sources !== undefined) attempted.set(operation, sources);
  const cwd = dirname(receipt.sourcePath);
  const cacheRoot = options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot };
  yield* Effect.promise(() => import("../runtime/bundled-plugins"));
  const rebuild = withDiscoveryCwd(cwd, refreshAppCache({ cwd, ...cacheRoot })).pipe(
    Effect.provide(
      makeLandoRuntime({
        bootstrap: "app",
        cwd,
        plugins: { policy: "discovery" },
        renderer: "json",
        logLevel: "none",
        telemetry: false,
        interaction: "non-interactive",
        ...cacheRoot,
      }),
    ),
  );
  // Typed failures become data so routing can defer to plugin/help fallbacks and then report
  // the rebuild's own error; interruption and defects still propagate.
  const failed = yield* withSlowRebuildNotice(receipt, options.rebuildNotice !== false, rebuild).pipe(
    Effect.as(undefined),
    Effect.catch((error) =>
      Effect.succeed<RebuildFailedReceipt>({
        status: "rebuild-failed",
        sourcePath: receipt.sourcePath,
        error,
      }),
    ),
  );
  if (failed === undefined) return yield* readAppCommandCacheForCwdDetailed(options);
  sources?.set(receipt.sourcePath, failed);
  return failed;
});
