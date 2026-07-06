import { McpTransportError } from "@lando/sdk/errors";

import type { McpTransportShape } from "./transport.ts";

export const makeMcpCancellationError = (id: string): McpTransportError =>
  new McpTransportError({
    message: `MCP request ${id} was cancelled before the tool call completed.`,
    remediation: "Retry the MCP tool call if the cancellation was unintended.",
  });

export const replyMcpCanceled = (transport: McpTransportShape, id: string) =>
  transport.reply({ id, ok: false, error: makeMcpCancellationError(id) });
