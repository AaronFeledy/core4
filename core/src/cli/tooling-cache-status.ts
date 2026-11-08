import type { AppCommandCacheReadResult } from "@lando/engine/cache/command-index-writer";
import type { ToolingCommandUnavailableError } from "@lando/sdk/errors";

/** A typed failure from the automatic index rebuild; the original tagged error instance. */
export interface ToolingRebuildFailure {
  readonly _tag: string;
  readonly message: string;
  readonly remediation?: string | undefined;
}

export type CliAppCommandCacheReadResult =
  | AppCommandCacheReadResult
  | { readonly status: "rebuild-failed"; readonly sourcePath: string; readonly error: ToolingRebuildFailure };

type CacheRecovery = {
  readonly reason: ToolingCommandUnavailableError["reason"];
  readonly remediation: string;
  readonly staleReason?: ToolingCommandUnavailableError["staleReason"];
  readonly sourcePath?: string;
};

export type ToolingMetadataStatus =
  | { readonly status: "fresh" | "not-app" }
  | ({ readonly status: "unavailable" } & CacheRecovery)
  | {
      readonly status: "unavailable";
      readonly reason: "rebuild-failed";
      readonly sourcePath?: string;
      readonly remediation: string;
      readonly error: { readonly _tag: string; readonly message: string };
    };

export const toolingCacheRecovery = (
  receipt: Exclude<AppCommandCacheReadResult, { readonly status: "fresh" }>,
): CacheRecovery => {
  const source = receipt.sourcePath === undefined ? {} : { sourcePath: receipt.sourcePath };
  switch (receipt.status) {
    case "missing":
      return {
        ...source,
        reason: "missing-cache",
        remediation:
          "Run the command from the app directory on your host; Lando builds this app's command list automatically.",
      };
    case "stale":
      return {
        ...source,
        reason: "stale-cache",
        staleReason: receipt.staleReason,
        remediation: "The app changed while Lando was reading it. Retry the command.",
      };
    case "invalid":
      return {
        ...source,
        reason: "invalid-cache",
        remediation: "Retry the command; Lando rebuilds this app's command list automatically.",
      };
    default:
      return receipt satisfies never;
  }
};

export const toolingMetadataStatus = (receipt: CliAppCommandCacheReadResult): ToolingMetadataStatus => {
  switch (receipt.status) {
    case "rebuild-failed":
      return {
        status: "unavailable",
        reason: "rebuild-failed",
        sourcePath: receipt.sourcePath,
        remediation: receipt.error.remediation ?? "Fix the reported problem, then run the command again.",
        error: { _tag: receipt.error._tag, message: receipt.error.message },
      };
    case "fresh":
      return { status: "fresh" };
    case "missing":
      if (receipt.sourcePath === undefined) return { status: "not-app" };
      return { status: "unavailable", ...toolingCacheRecovery(receipt) };
    case "stale":
    case "invalid":
      return { status: "unavailable", ...toolingCacheRecovery(receipt) };
    default:
      return receipt satisfies never;
  }
};

export const toolingMetadataNotice = (metadata?: ToolingMetadataStatus): readonly string[] => {
  if (metadata?.status !== "unavailable") return [];
  if (metadata.reason === "rebuild-failed")
    return [
      "",
      `This app's commands are unavailable: ${metadata.error.message}`,
      `  ↳ ${metadata.remediation}`,
    ];
  return [
    "",
    `Tooling metadata unavailable (${metadata.reason}${metadata.staleReason === undefined ? "" : `: ${metadata.staleReason}`}): ${metadata.remediation}`,
  ];
};
