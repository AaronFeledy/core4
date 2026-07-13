import { McpTransportError } from "@lando/sdk/errors";

import type { McpTransportShape } from "./transport.ts";

export const MAX_RETAINED_COMPLETED_REQUEST_IDS = 256;

export type CompletedRequestIds = ReadonlySet<string>;

export const emptyCompletedRequestIds = (): CompletedRequestIds => new Set<string>();

export const rememberCompletedRequestId = (
  completed: CompletedRequestIds,
  id: string,
): CompletedRequestIds => {
  const next = new Set(completed);
  next.delete(id);
  next.add(id);
  if (next.size <= MAX_RETAINED_COMPLETED_REQUEST_IDS) return next;
  const oldest = next.values().next();
  if (!oldest.done) next.delete(oldest.value);
  return next;
};

export const forgetCompletedRequestId = (completed: CompletedRequestIds, id: string): CompletedRequestIds => {
  if (!completed.has(id)) return completed;
  const next = new Set(completed);
  next.delete(id);
  return next;
};

export const makeMcpCancellationError = (id: string): McpTransportError =>
  new McpTransportError({
    message: `MCP request ${id} was cancelled before the tool call completed.`,
    remediation: "Retry the MCP tool call if the cancellation was unintended.",
  });

export const replyMcpCanceled = (transport: McpTransportShape, id: string) =>
  transport.reply({ id, ok: false, error: makeMcpCancellationError(id) });
