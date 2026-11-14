import { type CommandIndexEntry, commandIndexPresentation } from "@lando/engine/cache/command-index";
import { readAppCommandCacheForCwdDetailed } from "@lando/engine/cache/command-index-writer";
import type { McpAppGeneration } from "@lando/mcp/apps";
import type { McpDiagnostic, McpToolingCatalog } from "@lando/mcp/service";
import { resolveLandoRoots } from "@lando/paths";
import { ToolingCommandUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { CliInvocation } from "../../../runtime/invocation-context";
import { toolingCacheRecovery } from "../../tooling-cache-status";
import { toolingSpecFromRegistered } from "./mcp-tooling";

export const toolingCatalogFromCache = (
  revision: string,
  commands: readonly CommandIndexEntry[],
): McpToolingCatalog => {
  const unavailable: McpDiagnostic[] = [];
  const entries = commands.flatMap((command) => {
    if (command.visibility === "internal") return [];
    switch (command._tag) {
      case "Disabled":
        return [];
      case "Unavailable":
        unavailable.push({
          commandId: command.id,
          kind: "tooling",
          sourceKind: command.sourceKind === "tooling" ? "landofile" : "bun-script",
          _tag: command.diagnostic._tag,
          message: command.diagnostic.message,
          ...(command.diagnostic.remediation === undefined
            ? {}
            : { remediation: command.diagnostic.remediation }),
          ...("issues" in command.diagnostic
            ? {
                issues: command.diagnostic.issues,
                omittedIssueCount: command.diagnostic.omittedIssueCount,
                ...(command.diagnostic.source === undefined ? {} : { source: command.diagnostic.source }),
              }
            : {}),
        });
        return [];
      case "Ready":
        return [{ spec: toolingSpecFromRegistered(commandIndexPresentation(command)), tooling: true }];
      default:
        return command satisfies never;
    }
  });
  return { revision, entries, unavailable };
};

export const readMcpToolingCatalog = Effect.fnUntraced(function* (generation: McpAppGeneration) {
  const invocation = yield* CliInvocation;
  const roots = resolveLandoRoots({ env: invocation.env });
  const options = {
    cwd: invocation.cwd,
    env: invocation.env,
    cacheRoot: roots.userCacheRoot,
    roots,
    includeScriptInventory: true,
  };
  let receipt = yield* readAppCommandCacheForCwdDetailed(options);
  if (receipt.status !== "fresh" && receipt.sourcePath !== undefined) {
    const sourcePath = receipt.sourcePath;
    const { refreshAppCache } = yield* Effect.promise(() => import("../app-cache-refresh"));
    yield* refreshAppCache({
      cwd: invocation.cwd,
      env: invocation.env,
      cacheRoot: options.roots.userCacheRoot,
    }).pipe(Effect.provide(generation.context));
    receipt = yield* readAppCommandCacheForCwdDetailed(options);
    if (receipt.status !== "fresh") {
      const recovery = toolingCacheRecovery(receipt);
      return yield* Effect.fail(
        new ToolingCommandUnavailableError({
          message: `Tooling metadata is unavailable (${recovery.reason}${recovery.staleReason === undefined ? "" : `: ${recovery.staleReason}`}).`,
          commandId: "meta:mcp",
          tool: "tooling",
          ...recovery,
          sourcePath: recovery.sourcePath ?? sourcePath,
        }),
      );
    }
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
