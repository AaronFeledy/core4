import { Effect } from "effect";

import type { McpTransportError } from "@lando/sdk/errors";

import { stringifyBoundedJson } from "./bounded-json.ts";
import { type JsonRpcId, errorData, errorMessage, rpcError, rpcResult } from "./stdio-rpc.ts";
import type { McpTransportReply } from "./transport.ts";

const serializationErrorResponse = (id: JsonRpcId, error: McpTransportError) =>
  rpcError(id, -32603, error.message, {
    _tag: error._tag,
    remediation: error.remediation,
  });

export const encodeStdioReply = (
  reply: McpTransportReply,
  jsonrpcId: JsonRpcId,
): Effect.Effect<string, McpTransportError> => {
  const message = reply.ok
    ? stringifyBoundedJson(reply.result.envelope, "MCP tool result").pipe(
        Effect.map((text) =>
          rpcResult(jsonrpcId, {
            content: [{ type: "text", text }],
            isError: reply.result.ok === false,
          }),
        ),
      )
    : Effect.succeed(rpcError(jsonrpcId, -32603, errorMessage(reply), errorData(reply)));

  return message.pipe(
    Effect.flatMap((output) => stringifyBoundedJson(output, "MCP JSON-RPC response")),
    Effect.catchAll((error) =>
      stringifyBoundedJson(serializationErrorResponse(jsonrpcId, error), "MCP JSON-RPC error response"),
    ),
  );
};
