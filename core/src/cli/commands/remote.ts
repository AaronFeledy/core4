/** `lando remote`/`pull`/`push` result rendering. Operations live in `core/src/operations/remote.ts`. */
import type {
  RemoteEnvironment as RemoteEnvironmentType,
  RemoteTestResult,
  SyncResult as SyncResultType,
} from "@lando/sdk/schema";

import type { RemoteEntry, RemoteMutationResult } from "../../operations/remote.ts";
import type { RenderContext } from "../renderer-boundary.ts";

export const renderRemoteListResult = (
  result: ReadonlyArray<RemoteEntry>,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  if (result.length === 0) return "No remotes configured.";
  return result.map((entry) => `${entry.name}\t${entry.config.source}`).join("\n");
};

export const renderRemoteMutationResult = (
  result: RemoteMutationResult,
  action: "added" | "removed",
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  return `${action}: ${result.remote}`;
};

export const renderRemoteTestResult = (
  result: RemoteTestResult,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  return `${result.ok ? "ok" : "failed"}${result.env === undefined ? "" : `: ${result.env}`}${result.message === undefined ? "" : ` - ${result.message}`}`;
};

export const renderRemoteEnvListResult = (
  result: ReadonlyArray<RemoteEnvironmentType>,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  if (result.length === 0) return "No remote environments.";
  return result.map((entry) => `${entry.id}${entry.default === true ? "\t(default)" : ""}`).join("\n");
};

export const renderSyncResult = (
  result: SyncResultType,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  return `${result.direction}: ${result.remote}@${result.env} (${result.datasets.join(", ")})${result.changed ? " changed" : " unchanged"}`;
};
