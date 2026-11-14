import type { CommandIndexEntry } from "@lando/engine/cache/command-index";
import { readAppCommandCacheForCwdDetailed } from "@lando/engine/cache/command-index-writer";
import type { McpAppGeneration } from "@lando/mcp/apps";
import type { McpDiagnostic, McpToolingCatalog } from "@lando/mcp/service";
import { resolveLandoRoots } from "@lando/paths";
import { Effect } from "effect";
import { CliInvocation } from "../../../runtime/invocation-context";
import { toolingSpecFromRegistered } from "./mcp-tooling";

export const toolingCatalogFromCache = (
  revision: string,
  commands: readonly CommandIndexEntry[],
): McpToolingCatalog => {
  const unavailable: McpDiagnostic[] = [];
  const entries = commands.flatMap((command) => {
    if (command.hidden || command.disabled === true) return [];
    if (command.loadError !== undefined) {
      unavailable.push({
        commandId: command.id,
        kind: "tooling",
        sourceKind: command.source ?? "landofile",
        ...command.loadError,
      });
      return [];
    }
    return [{ spec: toolingSpecFromRegistered(command), tooling: true }];
  });
  return { revision, entries, unavailable };
};

export const readMcpToolingCatalog = Effect.fnUntraced(function* (generation: McpAppGeneration) {
  const invocation = yield* CliInvocation;
  const options = {
    cwd: invocation.cwd,
    roots: resolveLandoRoots({ env: invocation.env }),
    includeScriptInventory: true,
  };
  let receipt = yield* readAppCommandCacheForCwdDetailed(options);
  if (receipt.status !== "fresh" && receipt.sourcePath !== undefined) {
    const { refreshAppCache } = yield* Effect.promise(() => import("../app-cache-refresh"));
    yield* refreshAppCache({ cwd: invocation.cwd, cacheRoot: options.roots.userCacheRoot }).pipe(
      Effect.provide(generation.context),
    );
    receipt = yield* readAppCommandCacheForCwdDetailed(options);
  }
  return receipt.status === "fresh"
    ? toolingCatalogFromCache(
        JSON.stringify([
          receipt.payload.sourceContentHash,
          receipt.payload.entriesFingerprint ?? receipt.payload.entries,
        ]),
        receipt.payload.entries,
      )
    : ({ revision: receipt.status, entries: [], unavailable: [] } satisfies McpToolingCatalog);
});
