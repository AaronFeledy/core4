import type { AppCommandCacheReadResult } from "@lando/engine/cache/command-index-writer";
import type { ToolingCommandUnavailableError } from "@lando/sdk/errors";

type CacheRecovery = {
  readonly reason: Exclude<ToolingCommandUnavailableError["reason"], "unknown-command">;
  readonly remediation: string;
  readonly staleReason?: ToolingCommandUnavailableError["staleReason"];
  readonly sourcePath?: string;
};

export type ToolingMetadataStatus =
  | { readonly status: "fresh" | "not-app" }
  | ({ readonly status: "unavailable" } & CacheRecovery);

export const toolingCacheRecovery = (
  receipt: Exclude<AppCommandCacheReadResult, { readonly status: "fresh" }>,
): CacheRecovery => {
  const source = receipt.sourcePath === undefined ? {} : { sourcePath: receipt.sourcePath };
  switch (receipt.status) {
    case "missing":
      return {
        ...source,
        reason: "missing-cache",
        remediation: "Tooling metadata has not been cached. Run `lando app:cache:refresh` in this app.",
      };
    case "stale":
      return {
        ...source,
        reason: "stale-cache",
        staleReason: receipt.staleReason,
        remediation:
          "Tooling metadata no longer matches this app. Run `lando app:cache:refresh` before retrying.",
      };
    case "invalid":
      return {
        ...source,
        reason: "invalid-cache",
        remediation:
          "Tooling metadata cannot be decoded by this Lando version. Run `lando app:cache:refresh` to replace it.",
      };
    default:
      return receipt satisfies never;
  }
};

export const toolingMetadataStatus = (receipt: AppCommandCacheReadResult): ToolingMetadataStatus => {
  switch (receipt.status) {
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

export const toolingMetadataNotice = (metadata?: ToolingMetadataStatus): readonly string[] =>
  metadata?.status === "unavailable"
    ? [
        "",
        `Tooling metadata unavailable (${metadata.reason}${metadata.staleReason === undefined ? "" : `: ${metadata.staleReason}`}): ${metadata.remediation}`,
      ]
    : [];
