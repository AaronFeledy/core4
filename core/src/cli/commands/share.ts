/** `lando share` result rendering. Operations live in `core/src/operations/share.ts`. */
import type { TunnelSession as TunnelSessionType } from "@lando/sdk/schema";

import type { ShareStopResult } from "../../operations/share.ts";
import type { RenderContext } from "../renderer-boundary.ts";

export const renderShareResult = (
  result: TunnelSessionType,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  const target =
    result.target._tag === "service" ? `${result.target.service}:${result.target.port}` : result.target._tag;
  return `Tunnel ${result.id} ${result.status} via ${result.provider} (${target})${
    result.publicUrl === undefined ? "" : ` at ${result.publicUrl}`
  }\n`;
};

export const renderShareListResult = (
  result: ReadonlyArray<TunnelSessionType>,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  if (result.length === 0) return "No active tunnels.\n";
  return `${result.map((session) => `${session.id}\t${session.provider}\t${session.status}`).join("\n")}\n`;
};

export const renderShareStopResult = (
  result: ShareStopResult,
  _format: "text" | "json" = "text",
  _ctx?: RenderContext,
): string => {
  return `Tunnel ${result.sessionId} stopped.\n`;
};
