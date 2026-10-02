/** `lando share` result rendering. */
import type { TunnelSession as TunnelSessionType } from "@lando/sdk/schema";

import type { ShareStopResult } from "@lando/engine/operations/share";
import type { RenderContext } from "../renderer-boundary";
import { appendTerminalQr } from "../terminal-qr";

export const renderShareResult = (
  result: TunnelSessionType,
  format: "text" | "json" = "text",
  ctx?: RenderContext,
): string => {
  const target =
    result.target._tag === "service" ? `${result.target.service}:${result.target.port}` : result.target._tag;
  const line = `Tunnel ${result.id} ${result.status} via ${result.provider} (${target})${
    result.publicUrl === undefined ? "" : ` at ${result.publicUrl}`
  }\n`;
  return appendTerminalQr(line, {
    url: result.publicUrl,
    isTTY: ctx?.isTTY === true,
    format,
  });
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
